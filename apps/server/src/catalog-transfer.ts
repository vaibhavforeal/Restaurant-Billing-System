import { createHash } from "node:crypto";
import { CATALOG_CSV_COLUMNS, CATALOG_CSV_LIMIT, GST_RATES, catalogCsv, parseCatalogCsv, uuidv7, type CatalogImportPreview } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";

interface Category { id: string; name: string; sort_order: number; is_active: number }
interface Station { id: string; name: string; is_active: number }
interface Item {
  ac_price_paise: number | null; takeaway_price_paise: number | null; zomato_price_paise: number | null;
  id: string; category_id: string; name: string; price_paise: number; gst_rate: number;
  is_veg: number; is_active: number; is_sold_out: number; description: string; kot_station_id: string | null;
}
interface Variant { ac_price_paise: number | null; takeaway_price_paise: number | null; zomato_price_paise: number | null; id: string; product_id: string; name: string; price_paise: number; is_active: number }
const normalized = (s: string) => s.trim().toLowerCase();
const rupees = (paise: number) => (paise / 100).toFixed(2);
const itemColumns = "ac_price_paise, takeaway_price_paise, zomato_price_paise, id, category_id, name, price_paise, gst_rate, is_veg, is_active, is_sold_out, description, kot_station_id";

export function registerCatalogTransfer(app: FastifyInstance): void {
  const manage = app.requirePermission("catalog.manage");
  const snapshot = () => ({
    categories: app.db.prepare("SELECT id, name, sort_order, is_active FROM categories ORDER BY id").all() as Category[],
    stations: app.db.prepare("SELECT id, name, is_active FROM kot_stations ORDER BY id").all() as Station[],
    items: app.db.prepare(`SELECT ${itemColumns} FROM products ORDER BY id`).all() as Item[],
    variants: app.db.prepare("SELECT id, product_id, name, price_paise, is_active, ac_price_paise, takeaway_price_paise, zomato_price_paise FROM variants ORDER BY id").all() as Variant[],
  });

  app.get("/api/catalog/export", { preHandler: manage }, async (_req, reply) => {
    const data = snapshot();
    const categories = new Map(data.categories.map((c) => [c.id, c.name]));
    const stations = new Map(data.stations.map((s) => [s.id, s.name]));
    const variants = new Map<string, Variant[]>();
    for (const v of data.variants) variants.set(v.product_id, [...(variants.get(v.product_id) ?? []), v]);
    const rows: string[][] = [[...CATALOG_CSV_COLUMNS]];
    for (const p of data.items) {
      const base = [p.id, categories.get(p.category_id)!, p.name, rupees(p.price_paise), String(p.gst_rate),
        String(!!p.is_veg), String(!!p.is_active), String(!!p.is_sold_out), p.description,
        p.kot_station_id ? stations.get(p.kot_station_id)! : ""];
      const optional = (paise: number | null) => paise === null ? "" : rupees(paise);
      const service = [optional(p.ac_price_paise), optional(p.takeaway_price_paise)];
      rows.push([...base, "", "", "", "", ...service, "", "", optional(p.zomato_price_paise), ""]);
      for (const v of variants.get(p.id) ?? []) rows.push([...base, v.id, v.name, rupees(v.price_paise), String(!!v.is_active), ...service, optional(v.ac_price_paise), optional(v.takeaway_price_paise), optional(p.zomato_price_paise), optional(v.zomato_price_paise)]);
    }
    reply.header("Cache-Control", "no-store");
    return { filename: `forkflow-items-${new Date().toISOString().slice(0, 10)}.csv`, csv: catalogCsv(rows) };
  });

  function plan(csv: string) {
    if (Buffer.byteLength(csv, "utf8") > CATALOG_CSV_LIMIT) throw httpError(400, "CSV must be 5 MB or smaller.");
    let rows: ReturnType<typeof parseCatalogCsv>;
    try { rows = parseCatalogCsv(csv); }
    catch (e) { throw httpError(400, e instanceof Error ? e.message : "Invalid CSV"); }
    const data = snapshot();
    const revision = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const newCategories: Category[] = [];
    const items = new Map<string, { value: Item; isNew: boolean; baseRow: boolean }>();
    const variants = new Map<string, { value: Variant; isNew: boolean }>();
    const summary: CatalogImportPreview = {
      revision, created: 0, updated: 0, categoriesCreated: 0, variantsCreated: 0, variantsUpdated: 0, items: [],
    };
    for (const { row, values: v } of rows) {
      const fail = (message: string): never => { throw httpError(400, `Row ${row}: ${message}`); };
      const name = (value: string | undefined, field: string) => {
        if (!value?.trim()) return fail(`${field} is required.`);
        return value.trim();
      };
      const id = (value: string | undefined, field: string) => {
        if (!value?.trim()) return undefined;
        if (!z.string().uuid().safeParse(value.trim()).success) return fail(`${field} must be an exported UUID or blank.`);
        return value.trim();
      };
      const money = (value: string | undefined, field: string) => {
        if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return fail(`${field} must be a non-negative rupee amount with at most 2 decimal places.`);
        const [whole, fraction = ""] = value.trim().split(".");
        const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
        if (!Number.isSafeInteger(paise)) return fail(`${field} is too large.`);
        return paise;
      };
      const optionalMoney = (value: string | undefined, field: string, existing: number | null | undefined) =>
        value === undefined ? existing ?? null : value.trim() === "" ? null : money(value, field);
      const bool = (value: string | undefined, field: string, fallback: number) => {
        if (!value?.trim()) return fallback;
        if (["true", "1", "yes"].includes(normalized(value))) return 1;
        if (["false", "0", "no"].includes(normalized(value))) return 0;
        return fail(`${field} must be true or false.`);
      };
      const unique = <T,>(matches: T[], field: string): T | undefined => {
        if (matches.length > 1) return fail(`ambiguous ${field}; rename duplicate entries or use the exported item/variant ID.`);
        return matches[0];
      };
      const categoryName = name(v.category, "category");
      let category = unique([...data.categories, ...newCategories].filter((c) => normalized(c.name) === normalized(categoryName)), "category");
      if (!category) {
        category = { id: uuidv7(), name: categoryName, sort_order: 0, is_active: 1 };
        newCategories.push(category);
      }
      const itemName = name(v.name, "name");
      const itemId = id(v.item_id, "item_id");
      const existing = itemId ? data.items.find((p) => p.id === itemId)
        : unique(data.items.filter((p) => p.category_id === category.id && normalized(p.name) === normalized(itemName)), "item name");
      // An ID-less row can also refer to a new item already seen earlier in this file.
      const earlier = !itemId && !existing ? unique([...items.values()].filter((p) => p.value.category_id === category.id && normalized(p.value.name) === normalized(itemName)), "item name") : undefined;
      const resolvedId = existing?.id ?? itemId ?? earlier?.value.id ?? uuidv7();
      let stationId = existing?.kot_station_id ?? null;
      if (v.kot_station !== undefined) {
        stationId = null;
        if (v.kot_station.trim()) {
          const station = unique(data.stations.filter((s) => normalized(s.name) === normalized(v.kot_station!)), "KOT station");
          if (!station) return fail(`unknown KOT station "${v.kot_station}". Create it in Settings first.`);
          stationId = station.id;
        }
      }
      const gst = Number(v.gst_rate);
      if (!v.gst_rate?.trim() || !/^\d+(?:\.0+)?$/.test(v.gst_rate.trim()) || !(GST_RATES as readonly number[]).includes(gst)) return fail("gst_rate must be 0, 5, 12, 18 or 28.");
      const description = v.description?.trim() ?? existing?.description ?? "";
      if (description.length > 500) return fail("description must be 500 characters or fewer.");
      const value: Item = {
        id: resolvedId, category_id: category.id, name: itemName, price_paise: money(v.price, "price"), gst_rate: gst,
        is_veg: bool(v.is_veg, "is_veg", existing?.is_veg ?? 1),
        is_active: bool(v.is_active, "is_active", existing?.is_active ?? 1),
        is_sold_out: bool(v.is_sold_out, "is_sold_out", existing?.is_sold_out ?? 0),
        description, kot_station_id: stationId,
        ac_price_paise: optionalMoney(v.ac_price, "ac_price", existing?.ac_price_paise),
        takeaway_price_paise: optionalMoney(v.takeaway_price, "takeaway_price", existing?.takeaway_price_paise),
        zomato_price_paise: optionalMoney(v.zomato_price, "zomato_price", existing?.zomato_price_paise),
      };
      const hasVariant = !!v.variant_name?.trim();
      const previous = items.get(resolvedId);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) return fail("repeated item rows must have identical item details.");
      if (previous?.baseRow && !hasVariant) return fail("duplicate item row. Use a separate row only for each variant.");
      items.set(resolvedId, { value, isNew: !existing, baseRow: !hasVariant || (previous?.baseRow ?? false) });
      if (!hasVariant) {
        if (v.variant_id?.trim() || v.variant_price?.trim() || v.variant_active?.trim() || v.variant_ac_price?.trim() || v.variant_takeaway_price?.trim() || v.variant_zomato_price?.trim()) return fail("variant_name is required when variant fields are filled.");
        continue;
      }
      const variantName = name(v.variant_name, "variant_name");
      const variantId = id(v.variant_id, "variant_id");
      const oldVariant = variantId ? data.variants.find((entry) => entry.id === variantId)
        : unique(data.variants.filter((entry) => entry.product_id === resolvedId && normalized(entry.name) === normalized(variantName)), "variant name");
      if (oldVariant && oldVariant.product_id !== resolvedId) return fail("variant_id belongs to another item.");
      const resolvedVariantId = oldVariant?.id ?? variantId ?? uuidv7();
      if (variants.has(resolvedVariantId) || [...variants.values()].some((entry) => entry.value.product_id === resolvedId && normalized(entry.value.name) === normalized(variantName))) return fail("duplicate variant in this file.");
      variants.set(resolvedVariantId, { isNew: !oldVariant, value: {
        id: resolvedVariantId, product_id: resolvedId, name: variantName,
        ac_price_paise: optionalMoney(v.variant_ac_price, "variant_ac_price", oldVariant?.ac_price_paise),
        takeaway_price_paise: optionalMoney(v.variant_takeaway_price, "variant_takeaway_price", oldVariant?.takeaway_price_paise),
        zomato_price_paise: optionalMoney(v.variant_zomato_price, "variant_zomato_price", oldVariant?.zomato_price_paise),
        price_paise: money(v.variant_price, "variant_price"), is_active: bool(v.variant_active, "variant_active", oldVariant?.is_active ?? 1),
      } });
    }
    for (const p of items.values()) {
      if (p.isNew) summary.created++; else summary.updated++;
      summary.items.push({ name: p.value.name, category: [...data.categories, ...newCategories].find((c) => c.id === p.value.category_id)!.name,
        pricePaise: p.value.price_paise, action: p.isNew ? "Add" : "Update" });
    }
    for (const v of variants.values()) { if (v.isNew) summary.variantsCreated++; else summary.variantsUpdated++; }
    summary.categoriesCreated = newCategories.length;
    return { summary, newCategories, items, variants };
  }

  const request = z.object({ csv: z.string().min(1).max(CATALOG_CSV_LIMIT) });
  app.post("/api/catalog/import/preview", { preHandler: manage, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return plan(request.parse(req.body).csv).summary;
  });
  app.post("/api/catalog/import", { preHandler: manage, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const body = request.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const result = app.db.transaction(() => {
      const p = plan(body.csv);
      if (p.summary.revision !== body.revision) throw httpError(409, "The catalog changed after preview. Preview the file again before importing.");
      const addCategory = app.db.prepare("INSERT INTO categories (id, name, sort_order, is_active) VALUES (@id, @name, @sort_order, @is_active)");
      for (const c of p.newCategories) addCategory.run(c);
      const addItem = app.db.prepare(`INSERT INTO products (${itemColumns}, created_at) VALUES (@ac_price_paise, @takeaway_price_paise, @zomato_price_paise, @id, @category_id, @name, @price_paise, @gst_rate, @is_veg, @is_active, @is_sold_out, @description, @kot_station_id, @created_at)`);
      const updateItem = app.db.prepare(`UPDATE products SET ac_price_paise=@ac_price_paise, takeaway_price_paise=@takeaway_price_paise, zomato_price_paise=@zomato_price_paise, category_id=@category_id, name=@name, price_paise=@price_paise, gst_rate=@gst_rate,
        is_veg=@is_veg, is_active=@is_active, is_sold_out=@is_sold_out, description=@description, kot_station_id=@kot_station_id WHERE id=@id`);
      for (const item of p.items.values()) {
        if (item.isNew) addItem.run({ ...item.value, created_at: Date.now() });
        else updateItem.run(item.value);
      }
      const addVariant = app.db.prepare("INSERT INTO variants (id, product_id, name, price_paise, is_active, ac_price_paise, takeaway_price_paise, zomato_price_paise) VALUES (@id, @product_id, @name, @price_paise, @is_active, @ac_price_paise, @takeaway_price_paise, @zomato_price_paise)");
      const updateVariant = app.db.prepare("UPDATE variants SET ac_price_paise=@ac_price_paise, takeaway_price_paise=@takeaway_price_paise, zomato_price_paise=@zomato_price_paise, name=@name, price_paise=@price_paise, is_active=@is_active WHERE id=@id AND product_id=@product_id");
      for (const variant of p.variants.values()) (variant.isNew ? addVariant : updateVariant).run(variant.value);
      return p.summary;
    })();
    app.broadcast("catalog.changed", {});
    return result;
  });
}
