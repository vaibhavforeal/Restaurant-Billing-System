import {
  CategoryCreate, CategoryUpdate,
  ProductCreate, ProductUpdate,
  VariantCreate, VariantUpdate,
  StationCreate, StationUpdate,
  uuidv7,
} from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { menuPhotoUrl, validateMenuPhoto } from "./menu-photo.js";
import { z } from "zod";
import { registerCatalogTransfer } from "./catalog-transfer.js";

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
  ac_price_paise: number | null;
  takeaway_price_paise: number | null;
  zomato_price_paise: number | null;
  gst_rate: number | null;
  is_veg: number;
  kot_station_id: string | null;
  is_active: number;
  description: string;
  is_sold_out: number;
  photo_hash: string | null;
}

interface VariantRow {
  id: string;
  product_id: string;
  name: string;
  price_paise: number;
  ac_price_paise: number | null;
  takeaway_price_paise: number | null;
  zomato_price_paise: number | null;
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
  acPricePaise: r.ac_price_paise,
  takeawayPricePaise: r.takeaway_price_paise,
  zomatoPricePaise: r.zomato_price_paise,
  isActive: r.is_active === 1,
});

const toProduct = (r: ProductRow, variants: VariantRow[]) => ({
  id: r.id,
  categoryId: r.category_id,
  name: r.name,
  pricePaise: r.price_paise,
  acPricePaise: r.ac_price_paise,
  takeawayPricePaise: r.takeaway_price_paise,
  zomatoPricePaise: r.zomato_price_paise,
  gstRate: r.gst_rate,
  isVeg: r.is_veg === 1,
  kotStationId: r.kot_station_id,
  isActive: r.is_active === 1,
  variants: variants.map(toVariant),
  description: r.description,
  isSoldOut: r.is_sold_out === 1,
  photoVersion: r.photo_hash,
  photoUrl: menuPhotoUrl(r.id, r.photo_hash),
});

export function registerCatalog(app: FastifyInstance): void {
  registerCatalogTransfer(app);
  const read = app.requirePermission("catalog.read");
  const manage = app.requirePermission("catalog.manage");
  const changed = () => app.broadcast("catalog.changed", {});

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
    changed();
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
    changed();
    return { category: toCategory(getCategory(id)!) };
  });

  const productColumns = "ac_price_paise, takeaway_price_paise, zomato_price_paise, id, category_id, name, price_paise, gst_rate, is_veg, kot_station_id, is_active, description, is_sold_out, photo_hash";
  const getProduct = (id: string) =>
    app.db.prepare(`SELECT ${productColumns} FROM products WHERE id = ?`).get(id) as ProductRow | undefined;
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
    const products = app.db.prepare(`SELECT ${productColumns} FROM products ORDER BY name`).all() as ProductRow[];
    const variants = app.db.prepare("SELECT * FROM variants ORDER BY name").all() as VariantRow[];
    const byProduct = new Map<string, VariantRow[]>();
    for (const v of variants) {
      const list = byProduct.get(v.product_id) ?? [];
      list.push(v);
      byProduct.set(v.product_id, list);
    }
    const { gst_rate: defaultGstRate } = app.db.prepare("SELECT gst_rate FROM settings WHERE id = 1").get() as { gst_rate: number };
    return { products: products.map((p) => toProduct(p, byProduct.get(p.id) ?? [])), defaultGstRate };
  });

  app.post("/api/products", { preHandler: manage }, async (req, reply) => {
    const body = ProductCreate.parse(req.body);
    const photo = validateMenuPhoto(body.photo);
    checkRefs(body.categoryId, body.kotStationId);
    const id = uuidv7();
    const write = app.db.transaction(() => {
      app.db
        .prepare(
          "INSERT INTO products (id, category_id, name, price_paise, gst_rate, is_veg, kot_station_id, created_at, description, is_sold_out, photo_data, photo_hash, ac_price_paise, takeaway_price_paise, zomato_price_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, body.categoryId, body.name, body.pricePaise, body.gstRate, body.isVeg ? 1 : 0, body.kotStationId, Date.now(), body.description, body.isSoldOut ? 1 : 0, photo?.data ?? null, photo?.hash ?? null, body.acPricePaise ?? null, body.takeawayPricePaise ?? null, body.zomatoPricePaise ?? null);
      for (const v of body.variants) {
        app.db
          .prepare("INSERT INTO variants (id, product_id, name, price_paise, ac_price_paise, takeaway_price_paise, zomato_price_paise) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(uuidv7(), id, v.name, v.pricePaise, v.acPricePaise ?? null, v.takeawayPricePaise ?? null, v.zomatoPricePaise ?? null);
      }
    });
    write();
    changed();
    return reply.status(201).send({ product: toProduct(getProduct(id)!, variantsFor(id)) });
  });

  app.patch("/api/products/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ProductUpdate.parse(req.body);
    const photo = validateMenuPhoto(body.photo);
    const row = getProduct(id);
    if (!row) throw httpError(404, "product not found");
    checkRefs(body.categoryId, body.kotStationId);
    // undefined = unchanged, null = clear the station
    const station = body.kotStationId === undefined ? row.kot_station_id : body.kotStationId;
    app.db
      .prepare(
        `UPDATE products SET category_id = ?, name = ?, price_paise = ?, gst_rate = ?, is_veg = ?, kot_station_id = ?, is_active = ?,
          description = ?, is_sold_out = ?, photo_data = CASE WHEN ? THEN ? ELSE photo_data END,
          photo_hash = CASE WHEN ? THEN ? ELSE photo_hash END, ac_price_paise = ?, takeaway_price_paise = ?, zomato_price_paise = ? WHERE id = ?`,
      )
      .run(
        body.categoryId ?? row.category_id,
        body.name ?? row.name,
        body.pricePaise ?? row.price_paise,
        body.gstRate === undefined ? row.gst_rate : body.gstRate,
        (body.isVeg ?? row.is_veg === 1) ? 1 : 0,
        station,
        (body.isActive ?? row.is_active === 1) ? 1 : 0,
        body.description ?? row.description,
        (body.isSoldOut ?? row.is_sold_out === 1) ? 1 : 0,
        photo === undefined ? 0 : 1, photo?.data ?? null,
        photo === undefined ? 0 : 1, photo?.hash ?? null,
        body.acPricePaise === undefined ? row.ac_price_paise : body.acPricePaise,
        body.takeawayPricePaise === undefined ? row.takeaway_price_paise : body.takeawayPricePaise,
        body.zomatoPricePaise === undefined ? row.zomato_price_paise : body.zomatoPricePaise,
        id,
      );
    changed();
    return { product: toProduct(getProduct(id)!, variantsFor(id)) };
  });

  app.get("/api/products/:id/photo", { preHandler: read }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = app.db.prepare("SELECT photo_data FROM products WHERE id = ?").get(id) as { photo_data: string | null } | undefined;
    if (!row) throw httpError(404, "Product not found");
    return { photo: row.photo_data };
  });

  // Public dish photos are addressed by product ID and content hash. This route
  // returns only raster bytes and never exposes staff/catalog/stock metadata.
  app.get("/api/menu-images/:id/:version", async (req, reply) => {
    const { id, version } = z.object({ id: z.string().uuid(), version: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    if (!["development", "active", "grace"].includes(app.licensing.status().state)) throw httpError(403, "Menu photo unavailable");
    const row = app.db.prepare(`SELECT p.photo_data FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = ? AND p.photo_hash = ? AND p.is_active = 1 AND c.is_active = 1`).get(id, version) as { photo_data: string | null } | undefined;
    if (!row?.photo_data) throw httpError(404, "Menu photo unavailable");
    return reply.type("image/jpeg").header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600, immutable")
      .send(Buffer.from(row.photo_data.slice("data:image/jpeg;base64,".length), "base64"));
  });

  app.post("/api/products/:id/variants", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getProduct(id)) throw httpError(404, "product not found");
    const body = VariantCreate.parse(req.body);
    const vid = uuidv7();
    app.db
      .prepare("INSERT INTO variants (id, product_id, name, price_paise, ac_price_paise, takeaway_price_paise, zomato_price_paise) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(vid, id, body.name, body.pricePaise, body.acPricePaise ?? null, body.takeawayPricePaise ?? null, body.zomatoPricePaise ?? null);
    changed();
    return reply.status(201).send({ variant: toVariant(getVariant(vid)!) });
  });

  app.patch("/api/variants/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = VariantUpdate.parse(req.body);
    const row = getVariant(id);
    if (!row) throw httpError(404, "variant not found");
    app.db
      .prepare("UPDATE variants SET name = ?, price_paise = ?, is_active = ?, ac_price_paise = ?, takeaway_price_paise = ?, zomato_price_paise = ? WHERE id = ?")
      .run(body.name ?? row.name, body.pricePaise ?? row.price_paise, (body.isActive ?? row.is_active === 1) ? 1 : 0, body.acPricePaise === undefined ? row.ac_price_paise : body.acPricePaise, body.takeawayPricePaise === undefined ? row.takeaway_price_paise : body.takeawayPricePaise, body.zomatoPricePaise === undefined ? row.zomato_price_paise : body.zomatoPricePaise, id);
    changed();
    return { variant: toVariant(getVariant(id)!) };
  });

  // Replace existing GET /api/kot-stations
  app.get("/api/kot-stations", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT id, name, printer_id, is_active FROM kot_stations ORDER BY name")
      .all() as Array<{ id: string; name: string; printer_id: string | null; is_active: number }>;
    return {
      stations: rows.map((r) => ({
        id: r.id,
        name: r.name,
        printerId: r.printer_id,
        isActive: r.is_active === 1,
      })),
    };
  });

  app.post("/api/kot-stations", { preHandler: manage }, async (req, reply) => {
    const body = StationCreate.parse(req.body);
    if (body.printerId) {
      const printer = app.db.prepare("SELECT id FROM printers WHERE id = ?").get(body.printerId);
      if (!printer) throw httpError(400, "unknown printer");
    }
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO kot_stations (id, name, printer_id) VALUES (?, ?, ?)")
      .run(id, body.name, body.printerId);
    const row = app.db
      .prepare("SELECT id, name, printer_id, is_active FROM kot_stations WHERE id = ?")
      .get(id) as { id: string; name: string; printer_id: string | null; is_active: number };
    return reply.status(201).send({
      station: {
        id: row.id,
        name: row.name,
        printerId: row.printer_id,
        isActive: row.is_active === 1,
      },
    });
  });

  app.patch("/api/kot-stations/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = StationUpdate.parse(req.body);
    const row = app.db
      .prepare("SELECT * FROM kot_stations WHERE id = ?")
      .get(id) as { id: string; name: string; printer_id: string | null; is_active: number } | undefined;
    if (!row) throw httpError(404, "station not found");

    if (body.printerId !== undefined && body.printerId !== null) {
      const printer = app.db.prepare("SELECT id FROM printers WHERE id = ?").get(body.printerId);
      if (!printer) throw httpError(400, "unknown printer");
    }

    app.db
      .prepare("UPDATE kot_stations SET name = ?, printer_id = ?, is_active = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.printerId === undefined ? row.printer_id : body.printerId,
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : row.is_active,
        id,
      );

    const updated = app.db
      .prepare("SELECT id, name, printer_id, is_active FROM kot_stations WHERE id = ?")
      .get(id) as { id: string; name: string; printer_id: string | null; is_active: number };
    return {
      station: {
        id: updated.id,
        name: updated.name,
        printerId: updated.printer_id,
        isActive: updated.is_active === 1,
      },
    };
  });
}
