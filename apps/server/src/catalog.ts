import {
  CategoryCreate, CategoryUpdate,
  ProductCreate, ProductUpdate,
  VariantCreate, VariantUpdate,
  uuidv7,
} from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: number;
}

interface ProductRow {
  id: string;
  category_id: string;
  name: string;
  price_paise: number;
  gst_rate: number;
  is_veg: number;
  kot_station_id: string | null;
  is_active: number;
}

interface VariantRow {
  id: string;
  product_id: string;
  name: string;
  price_paise: number;
  is_active: number;
}

const toCategory = (r: CategoryRow) => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sort_order,
  isActive: r.is_active === 1,
});

const toVariant = (r: VariantRow) => ({
  id: r.id,
  name: r.name,
  pricePaise: r.price_paise,
  isActive: r.is_active === 1,
});

const toProduct = (r: ProductRow, variants: VariantRow[]) => ({
  id: r.id,
  categoryId: r.category_id,
  name: r.name,
  pricePaise: r.price_paise,
  gstRate: r.gst_rate,
  isVeg: r.is_veg === 1,
  kotStationId: r.kot_station_id,
  isActive: r.is_active === 1,
  variants: variants.map(toVariant),
});

export function registerCatalog(app: FastifyInstance): void {
  const read = app.requirePermission("catalog.read");
  const manage = app.requirePermission("catalog.manage");

  const getCategory = (id: string) =>
    app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;

  app.get("/api/categories", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM categories ORDER BY sort_order, name").all() as CategoryRow[];
    return { categories: rows.map(toCategory) };
  });

  app.post("/api/categories", { preHandler: manage }, async (req, reply) => {
    const body = CategoryCreate.parse(req.body);
    const id = uuidv7();
    app.db.prepare("INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)").run(id, body.name, body.sortOrder);
    return reply.status(201).send({ category: toCategory(getCategory(id)!) });
  });

  app.patch("/api/categories/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CategoryUpdate.parse(req.body);
    const row = getCategory(id);
    if (!row) throw httpError(404, "category not found");
    app.db
      .prepare("UPDATE categories SET name = ?, sort_order = ?, is_active = ? WHERE id = ?")
      .run(body.name ?? row.name, body.sortOrder ?? row.sort_order, (body.isActive ?? row.is_active === 1) ? 1 : 0, id);
    return { category: toCategory(getCategory(id)!) };
  });

  const getProduct = (id: string) =>
    app.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
  const getVariant = (id: string) =>
    app.db.prepare("SELECT * FROM variants WHERE id = ?").get(id) as VariantRow | undefined;
  const variantsFor = (productId: string) =>
    app.db.prepare("SELECT * FROM variants WHERE product_id = ? ORDER BY name").all(productId) as VariantRow[];

  // Pre-check FK references so a bad id is a 400, not an SQLite error 500.
  const checkRefs = (categoryId: string | undefined, kotStationId: string | null | undefined) => {
    if (categoryId !== undefined && !getCategory(categoryId)) throw httpError(400, "unknown category");
    if (kotStationId != null && !app.db.prepare("SELECT id FROM kot_stations WHERE id = ?").get(kotStationId)) {
      throw httpError(400, "unknown KOT station");
    }
  };

  app.get("/api/products", { preHandler: read }, async () => {
    const products = app.db.prepare("SELECT * FROM products ORDER BY name").all() as ProductRow[];
    const variants = app.db.prepare("SELECT * FROM variants ORDER BY name").all() as VariantRow[];
    const byProduct = new Map<string, VariantRow[]>();
    for (const v of variants) {
      const list = byProduct.get(v.product_id) ?? [];
      list.push(v);
      byProduct.set(v.product_id, list);
    }
    return { products: products.map((p) => toProduct(p, byProduct.get(p.id) ?? [])) };
  });

  app.post("/api/products", { preHandler: manage }, async (req, reply) => {
    const body = ProductCreate.parse(req.body);
    checkRefs(body.categoryId, body.kotStationId);
    const id = uuidv7();
    const write = app.db.transaction(() => {
      app.db
        .prepare(
          "INSERT INTO products (id, category_id, name, price_paise, gst_rate, is_veg, kot_station_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, body.categoryId, body.name, body.pricePaise, body.gstRate, body.isVeg ? 1 : 0, body.kotStationId, Date.now());
      for (const v of body.variants) {
        app.db
          .prepare("INSERT INTO variants (id, product_id, name, price_paise) VALUES (?, ?, ?, ?)")
          .run(uuidv7(), id, v.name, v.pricePaise);
      }
    });
    write();
    return reply.status(201).send({ product: toProduct(getProduct(id)!, variantsFor(id)) });
  });

  app.patch("/api/products/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ProductUpdate.parse(req.body);
    const row = getProduct(id);
    if (!row) throw httpError(404, "product not found");
    checkRefs(body.categoryId, body.kotStationId);
    // undefined = unchanged, null = clear the station
    const station = body.kotStationId === undefined ? row.kot_station_id : body.kotStationId;
    app.db
      .prepare(
        "UPDATE products SET category_id = ?, name = ?, price_paise = ?, gst_rate = ?, is_veg = ?, kot_station_id = ?, is_active = ? WHERE id = ?",
      )
      .run(
        body.categoryId ?? row.category_id,
        body.name ?? row.name,
        body.pricePaise ?? row.price_paise,
        body.gstRate ?? row.gst_rate,
        (body.isVeg ?? row.is_veg === 1) ? 1 : 0,
        station,
        (body.isActive ?? row.is_active === 1) ? 1 : 0,
        id,
      );
    return { product: toProduct(getProduct(id)!, variantsFor(id)) };
  });

  app.post("/api/products/:id/variants", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) throw httpError(404, "product not found");
    const body = VariantCreate.parse(req.body);
    const vid = uuidv7();
    app.db
      .prepare("INSERT INTO variants (id, product_id, name, price_paise) VALUES (?, ?, ?, ?)")
      .run(vid, id, body.name, body.pricePaise);
    return reply.status(201).send({ variant: toVariant(getVariant(vid)!) });
  });

  app.patch("/api/variants/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = VariantUpdate.parse(req.body);
    const row = getVariant(id);
    if (!row) throw httpError(404, "variant not found");
    app.db
      .prepare("UPDATE variants SET name = ?, price_paise = ?, is_active = ? WHERE id = ?")
      .run(body.name ?? row.name, body.pricePaise ?? row.price_paise, (body.isActive ?? row.is_active === 1) ? 1 : 0, id);
    return { variant: toVariant(getVariant(id)!) };
  });

  app.get("/api/kot-stations", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT id, name FROM kot_stations WHERE is_active = 1 ORDER BY name")
      .all() as Array<{ id: string; name: string }>;
    return { stations: rows };
  });
}
