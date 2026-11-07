import { AddonGroupCreate, AddonGroupUpdate, uuidv7, type AddonGroup, type AddonOptionInputValue, type Database } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface GroupRow { id: string; name: string; min_picks: number; max_picks: number; is_active: number }
interface OptionRow {
  id: string; group_id: string; product_id: string; variant_id: string | null;
  product_name: string; variant_name: string | null; product_active: number; sold_out: number; variant_active: number | null;
}

/** Groups by id, each with its options in order. An option is unavailable while its item is sold out or switched off. */
function loadGroups(db: Database, ids?: string[]): Map<string, AddonGroup> {
  const filter = ids ? `WHERE g.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const groups = db.prepare(`SELECT g.id, g.name, g.min_picks, g.max_picks, g.is_active FROM addon_groups g ${filter} ORDER BY g.created_at, g.id`)
    .all(...(ids ?? [])) as GroupRow[];
  const options = db.prepare(`SELECT o.id, o.group_id, o.product_id, o.variant_id, p.name AS product_name, v.name AS variant_name,
      p.is_active AS product_active, p.is_sold_out AS sold_out, v.is_active AS variant_active
    FROM addon_group_options o JOIN addon_groups g ON g.id = o.group_id JOIN products p ON p.id = o.product_id LEFT JOIN variants v ON v.id = o.variant_id
    ${filter} ORDER BY o.group_id, o.sort_order`).all(...(ids ?? [])) as OptionRow[];
  const result = new Map<string, AddonGroup>();
  for (const g of groups) result.set(g.id, { id: g.id, name: g.name, minPicks: g.min_picks, maxPicks: g.max_picks, isActive: g.is_active === 1, options: [] });
  for (const o of options) {
    result.get(o.group_id)?.options.push({
      id: o.id, productId: o.product_id, variantId: o.variant_id,
      name: o.variant_name ? `${o.product_name} (${o.variant_name})` : o.product_name,
      ...(o.product_active !== 1 || o.sold_out === 1 || o.variant_active === 0 ? { unavailable: true } : {}),
    });
  }
  return result;
}

/** Each item's attached add-on groups, in the order the admin set; archived groups included (order taking skips them). */
export function addonGroupsByProduct(db: Database): Map<string, AddonGroup[]> {
  const links = db.prepare("SELECT product_id, group_id FROM product_addon_groups ORDER BY product_id, sort_order").all() as Array<{ product_id: string; group_id: string }>;
  const groups = loadGroups(db);
  const result = new Map<string, AddonGroup[]>();
  for (const link of links) {
    const group = groups.get(link.group_id);
    if (group) result.set(link.product_id, [...result.get(link.product_id) ?? [], group]);
  }
  return result;
}

/** One item's attached add-on groups, in order. */
export function addonGroupsFor(db: Database, productId: string): AddonGroup[] {
  const ids = (db.prepare("SELECT group_id FROM product_addon_groups WHERE product_id = ? ORDER BY sort_order").all(productId) as Array<{ group_id: string }>).map((r) => r.group_id);
  if (!ids.length) return [];
  const groups = loadGroups(db, ids);
  return ids.map((id) => groups.get(id)).filter((g): g is AddonGroup => !!g);
}

/** Every group, with the items it is attached to. */
export function listAddonGroups(db: Database): Array<AddonGroup & { productIds: string[] }> {
  const links = db.prepare("SELECT l.group_id, l.product_id FROM product_addon_groups l JOIN products p ON p.id = l.product_id ORDER BY p.name, p.id").all() as Array<{ group_id: string; product_id: string }>;
  return [...loadGroups(db).values()].map((group) => ({ ...group, productIds: links.filter((l) => l.group_id === group.id).map((l) => l.product_id) }));
}

const groupJson = (db: Database, id: string) => listAddonGroups(db).find((g) => g.id === id)!;

/** An add-on is an active ordinary item; an item with sizes is listed per size. Throws a 400 naming the problem. */
function checkOptions(db: Database, options: AddonOptionInputValue[]): void {
  for (const option of options) {
    const product = db.prepare("SELECT name, kind, is_active FROM products WHERE id = ?").get(option.productId) as { name: string; kind: string; is_active: number } | undefined;
    if (!product) throw httpError(400, "unknown product");
    if (product.kind === "combo") throw httpError(400, `${product.name} is a combo and cannot be an add-on`);
    if (product.is_active !== 1) throw httpError(400, `${product.name} is switched off`);
    if (option.variantId) {
      const variant = db.prepare("SELECT product_id FROM variants WHERE id = ?").get(option.variantId) as { product_id: string } | undefined;
      if (!variant) throw httpError(400, "unknown variant");
      if (variant.product_id !== option.productId) throw httpError(400, "variant does not belong to product");
    } else if (db.prepare("SELECT 1 FROM variants WHERE product_id = ? LIMIT 1").get(option.productId)) {
      throw httpError(400, `${product.name}: choose which size is the add-on`);
    }
  }
}

/** Replaces a group's options. Options sent back with their id keep it, so a cart picked before the edit still matches. */
function saveOptions(db: Database, groupId: string, options: AddonOptionInputValue[]): void {
  const previous = new Set((db.prepare("SELECT id FROM addon_group_options WHERE group_id = ?").all(groupId) as Array<{ id: string }>).map((r) => r.id));
  const kept = new Set(options.map((o) => o.id).filter((id): id is string => !!id && previous.has(id)));
  for (const id of previous) if (!kept.has(id)) db.prepare("DELETE FROM addon_group_options WHERE id = ?").run(id);
  options.forEach((option, index) => {
    if (option.id && kept.has(option.id)) {
      db.prepare("UPDATE addon_group_options SET product_id = ?, variant_id = ?, sort_order = ? WHERE id = ?").run(option.productId, option.variantId, index, option.id);
    } else {
      db.prepare("INSERT INTO addon_group_options (id, group_id, product_id, variant_id, sort_order) VALUES (?, ?, ?, ?, ?)").run(uuidv7(), groupId, option.productId, option.variantId, index);
    }
  });
}

/** Replaces an item's attached groups, in the given order. Unknown or archived groups are a 400. Call inside a transaction. */
export function saveProductAddonGroups(db: Database, productId: string, groupIds: string[]): void {
  if (new Set(groupIds).size !== groupIds.length) throw httpError(400, "A group is attached twice");
  for (const id of groupIds) {
    const group = db.prepare("SELECT name, is_active FROM addon_groups WHERE id = ?").get(id) as { name: string; is_active: number } | undefined;
    if (!group) throw httpError(400, "unknown add-on group");
    if (group.is_active !== 1) throw httpError(400, `${group.name} is archived`);
  }
  db.prepare("DELETE FROM product_addon_groups WHERE product_id = ?").run(productId);
  groupIds.forEach((id, index) => db.prepare("INSERT INTO product_addon_groups (product_id, group_id, sort_order) VALUES (?, ?, ?)").run(productId, id, index));
}

export function registerAddonGroups(app: FastifyInstance): void {
  const read = app.requirePermission("catalog.read");
  const manage = app.requirePermission("catalog.manage");
  const changed = () => app.broadcast("catalog.changed", {});

  app.get("/api/addon-groups", { preHandler: read }, async () => ({ groups: listAddonGroups(app.db) }));

  app.post("/api/addon-groups", { preHandler: manage }, async (req, reply) => {
    const body = AddonGroupCreate.parse(req.body);
    checkOptions(app.db, body.options);
    const id = uuidv7();
    app.db.transaction(() => {
      app.db.prepare("INSERT INTO addon_groups (id, name, min_picks, max_picks, created_at) VALUES (?, ?, ?, ?, ?)").run(id, body.name, body.minPicks, body.maxPicks, Date.now());
      saveOptions(app.db, id, body.options);
    })();
    changed();
    return reply.status(201).send({ group: groupJson(app.db, id) });
  });

  app.patch("/api/addon-groups/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = AddonGroupUpdate.parse(req.body);
    const row = app.db.prepare("SELECT id, name, min_picks, max_picks, is_active FROM addon_groups WHERE id = ?").get(id) as GroupRow | undefined;
    if (!row) throw httpError(404, "add-on group not found");
    const name = body.name ?? row.name, minPicks = body.minPicks ?? row.min_picks, maxPicks = body.maxPicks ?? row.max_picks;
    const optionCount = body.options?.length ?? (app.db.prepare("SELECT COUNT(*) AS n FROM addon_group_options WHERE group_id = ?").get(id) as { n: number }).n;
    if (minPicks > maxPicks) throw httpError(400, `${name}: the minimum is more than the maximum`);
    if (minPicks > optionCount) throw httpError(400, `${name}: the minimum is more than its ${optionCount} add-ons`);
    if (body.options) checkOptions(app.db, body.options);
    app.db.transaction(() => {
      app.db.prepare("UPDATE addon_groups SET name = ?, min_picks = ?, max_picks = ?, is_active = ? WHERE id = ?")
        .run(name, minPicks, maxPicks, (body.isActive ?? row.is_active === 1) ? 1 : 0, id);
      if (body.options) saveOptions(app.db, id, body.options);
    })();
    changed();
    return { group: groupJson(app.db, id) };
  });
}
