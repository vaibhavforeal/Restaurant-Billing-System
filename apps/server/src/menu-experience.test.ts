import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";

// Real 2x2 baseline and 1x1 progressive JPEG fixtures; both also decoded by
// Windows GDI+ when prepared. The progressive fixture contains two scans.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD1Dwj4c0O58F6FPPo2nSzS6dbvJJJaozOxjUkkkZJJ70UUVwVfjfqeXW/iS9Wf/9k=", "base64");
const PROGRESSIVE = Buffer.from("/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wgALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAAAB//9oACAEBAAE/AH//2Q==", "base64");
const photoData = (bytes = JPEG) => `data:image/jpeg;base64,${bytes.toString("base64")}`;
const photoHash = (bytes = JPEG) => createHash("sha256").update(bytes).digest("hex");
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); app.db.close(); }
});

async function fixture() {
  let { app } = freshAppWithFakeSink(); apps.push(app);
  const { token } = await setupAdmin(app);
  const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload === undefined ? {} : { payload }) });
  const categoryResponse = await api("POST", "/api/categories", { name: "Meals" });
  expect(categoryResponse.statusCode, categoryResponse.body).toBe(201);
  const categoryId = categoryResponse.json().category.id as string;
  const body = { categoryId, name: "Rice bowl", pricePaise: 10000, gstRate: 5, description: "  Rice with fresh vegetables  ", photo: photoData() };
  async function create(fields: object = {}) {
    const response = await api("POST", "/api/products", { ...body, ...fields });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().product as { id: string; description: string; photoVersion: string | null; photoUrl: string | null; isSoldOut: boolean };
  }
  async function restart() {
    const db = app.db;
    await app.close(); apps.splice(apps.indexOf(app), 1);
    app = buildServer({ db, sinkSend: makeFakeSink().send }); apps.push(app);
  }
  return { app, token, api, categoryId, body, create, restart };
}

describe("menu descriptions and photos", () => {
  it("persists trimmed descriptions and versioned photos without putting photo blobs in catalog lists", async () => {
    const f = await fixture(); const product = await f.create();
    expect(product).toMatchObject({ description: "Rice with fresh vegetables", photoVersion: photoHash(), photoUrl: `/api/menu-images/${product.id}/${photoHash()}` });
    expect(product).not.toHaveProperty("photo");
    expect(product).not.toHaveProperty("photo_data");
    const listed = await f.api("GET", "/api/products");
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().products).toEqual([product]);
    expect(listed.body).not.toContain("data:image");
    expect(f.app.db.prepare("SELECT description, photo_data, photo_hash FROM products WHERE id = ?").get(product.id))
      .toEqual({ description: "Rice with fresh vegetables", photo_data: photoData(), photo_hash: photoHash() });
    await f.restart();
    expect((await f.api("GET", "/api/products")).json().products).toEqual([product]);
    expect((await f.api("GET", `/api/products/${product.id}/photo`)).json()).toEqual({ photo: photoData() });
  });

  it("preserves omitted photos and descriptions, replaces photos, and removes them only with explicit null", async () => {
    const f = await fixture(); const product = await f.create();
    const unchanged = await f.api("PATCH", `/api/products/${product.id}`, { pricePaise: 12000 });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().product).toMatchObject({ description: product.description, photoVersion: product.photoVersion, photoUrl: product.photoUrl });
    expect((await f.api("GET", `/api/products/${product.id}/photo`)).json().photo).toBe(photoData());
    const replaced = await f.api("PATCH", `/api/products/${product.id}`, { description: "Updated description", photo: photoData(PROGRESSIVE) });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().product).toMatchObject({ description: "Updated description", photoVersion: photoHash(PROGRESSIVE) });
    const cleared = await f.api("PATCH", `/api/products/${product.id}`, { photo: null, description: "" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().product).toMatchObject({ description: "", photoVersion: null, photoUrl: null });
    expect((await f.api("GET", `/api/products/${product.id}/photo`)).json()).toEqual({ photo: null });
    expect(f.app.db.prepare("SELECT photo_data, photo_hash FROM products WHERE id = ?").get(product.id)).toEqual({ photo_data: null, photo_hash: null });
  });

  it("serves only the current active JPEG version with its raster content type and no staff metadata", async () => {
    const f = await fixture(); const product = await f.create();
    const first = await f.app.inject({ url: product.photoUrl! });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["content-type"]).toBe("image/jpeg");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.rawPayload).toEqual(JPEG);
    const changed = await f.api("PATCH", `/api/products/${product.id}`, { photo: photoData(PROGRESSIVE) });
    expect(changed.statusCode, changed.body).toBe(200);
    const nextUrl = changed.json().product.photoUrl as string;
    expect(nextUrl).not.toBe(product.photoUrl);
    expect((await f.app.inject({ url: product.photoUrl! })).statusCode).toBe(404);
    expect((await f.app.inject({ url: nextUrl })).rawPayload).toEqual(PROGRESSIVE);
    expect((await f.api("PATCH", `/api/products/${product.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await f.app.inject({ url: nextUrl })).statusCode).toBe(404);
    expect((await f.api("PATCH", `/api/products/${product.id}`, { isActive: true })).statusCode).toBe(200);
    expect((await f.api("PATCH", `/api/categories/${f.categoryId}`, { isActive: false })).statusCode).toBe(200);
    expect((await f.app.inject({ url: nextUrl })).statusCode).toBe(404);
    expect((await f.api("PATCH", `/api/categories/${f.categoryId}`, { isActive: true })).statusCode).toBe(200);
    expect((await f.api("PATCH", `/api/products/${product.id}`, { photo: null })).statusCode).toBe(200);
    expect((await f.app.inject({ url: nextUrl })).statusCode).toBe(404);
  });

  it("requires staff catalog access for editable photo data and prevents read-only users changing it", async () => {
    const f = await fixture(); const product = await f.create();
    const cashier = await createUser(f.app, f.token, { name: "Cashier", role: "cashier", pin: "2345" });
    expect((await f.app.inject({ url: `/api/products/${product.id}/photo` })).statusCode).toBe(401);
    const own = await f.api("GET", `/api/products/${product.id}/photo`, undefined, cashier.token);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(own.json()).toEqual({ photo: photoData() });
    expect((await f.api("PATCH", `/api/products/${product.id}`, { photo: null }, cashier.token)).statusCode).toBe(403);
    expect((await f.api("GET", `/api/products/${randomUUID()}/photo`)).statusCode).toBe(404);
  });

  it("rejects non-JPEG, oversized, invalid-base64 and out-of-range images without losing the existing photo", async () => {
    const f = await fixture(); const product = await f.create();
    const dimensions = (width: number, height: number) => {
      const bytes = Buffer.from(JPEG), frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      bytes.writeUInt16BE(height, frame + 5); bytes.writeUInt16BE(width, frame + 7); return photoData(bytes);
    };
    const invalid = [
      { label: "PNG data", photo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=" },
      { label: "SVG data", photo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
      { label: "external URL", photo: "https://example.com/photo.jpg" },
      { label: "local file", photo: "C:\\photo.jpg" },
      { label: "non-raster bytes", photo: photoData(Buffer.from("<svg>not a JPEG</svg>")) },
      { label: "oversized photo", photo: photoData(Buffer.concat([JPEG.subarray(0, -2), Buffer.alloc(400 * 1024, 1), JPEG.subarray(-2)])) },
      { label: "too wide", photo: dimensions(1601, 2) }, { label: "too tall", photo: dimensions(2, 1601) },
      { label: "zero width", photo: dimensions(0, 2) }, { label: "zero height", photo: dimensions(2, 0) },
      { label: "noncanonical base64", photo: photoData().replace(/=$/, "") },
      { label: "truncated JPEG", photo: photoData(JPEG.subarray(0, -2)) },
    ];
    const broadcast = vi.spyOn(f.app, "broadcast");
    for (const input of invalid) {
      const response = await f.api("PATCH", `/api/products/${product.id}`, { photo: input.photo, description: "Should not persist" });
      expect(response.statusCode, `${input.label}: ${response.body}`).toBe(400);
      expect((await f.api("GET", `/api/products/${product.id}/photo`)).json()).toEqual({ photo: photoData() });
    }
    expect((await f.api("GET", "/api/products")).json().products[0].description).toBe(product.description);
    expect(broadcast).not.toHaveBeenCalled();
    expect((await f.api("POST", "/api/products", { ...f.body, photo: invalid[4]!.photo })).statusCode).toBe(400);
    expect((await f.api("PATCH", `/api/products/${product.id}`, { description: "x".repeat(501) })).statusCode).toBe(400);
  });

  it("rejects fabricated frames, empty scans, invalid tables and malformed later progressive scans", async () => {
    const f = await fixture(); const product = await f.create();
    const frame = JPEG.indexOf(Buffer.from([0xff, 0xc0])), scan = JPEG.indexOf(Buffer.from([0xff, 0xda]));
    const noComponents = Buffer.from(JPEG); noComponents[frame + 9] = 0;
    const scanHeaderEnd = scan + 2 + JPEG.readUInt16BE(scan + 2);
    const emptyScan = Buffer.concat([JPEG.subarray(0, scanHeaderEnd), Buffer.from([0xff, 0xd9])]);
    const fake = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    const brokenTable = Buffer.from(JPEG); brokenTable[JPEG.indexOf(Buffer.from([0xff, 0xc4])) + 4] = 0x0f;
    const brokenProgressive = Buffer.from(PROGRESSIVE);
    const secondScan = brokenProgressive.indexOf(Buffer.from([0xff, 0xda]), brokenProgressive.indexOf(Buffer.from([0xff, 0xda])) + 2);
    brokenProgressive[secondScan + 4] = 0;
    for (const [label, bytes] of [["zero frame components", noComponents], ["empty scan", emptyScan], ["fabricated JPEG", fake],
      ["invalid Huffman table", brokenTable], ["invalid later scan", brokenProgressive]] as const) {
      const response = await f.api("PATCH", `/api/products/${product.id}`, { photo: photoData(bytes) });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
    }
    expect((await f.api("GET", `/api/products/${product.id}/photo`)).json().photo).toBe(photoData());
  });

  it("keeps the guest pricing version stable when only a photo or description changes", async () => {
    const f = await fixture(); const product = await f.create();
    const table = await f.api("POST", "/api/tables", { name: "T1" });
    const qr = await f.api("PUT", `/api/qr/tables/${table.json().table.id}`, { enabled: true });
    const token = qr.json().table.path.split("#")[1];
    const menu = () => f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": token } });
    const before = (await menu()).json();
    expect(before.products[0]).toMatchObject({ description: product.description, photoUrl: product.photoUrl });
    expect((await f.api("PATCH", `/api/products/${product.id}`, { description: "A new description", photo: photoData(PROGRESSIVE) })).statusCode).toBe(200);
    const after = await menu();
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().menuVersion).toBe(before.menuVersion);
    expect(after.json().products[0]).toMatchObject({ description: "A new description", photoUrl: `/api/menu-images/${product.id}/${photoHash(PROGRESSIVE)}` });
    expect(after.body).not.toContain("data:image");
    expect(after.json().products[0]).not.toHaveProperty("photo_data");
  });
});

describe("menu experience migration", () => {
  it("adds safe product defaults and links only canonical accepted guest item references belonging to the same order", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version < 10));
      const userId = randomUUID(), categoryId = randomUUID(), productId = randomUUID(), tableId = randomUUID();
      const orderId = randomUUID(), otherOrderId = randomUUID(), requestId = randomUUID(), pendingId = randomUUID();
      db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Owner', 'fixture', 'admin', 0)").run(userId);
      db.prepare("INSERT INTO categories (id, name) VALUES (?, 'Meals')").run(categoryId);
      db.prepare("INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES (?, ?, 'Rice bowl', 10000, 5, 0)").run(productId, categoryId);
      db.prepare("INSERT INTO dining_tables (id, name) VALUES (?, 'T1')").run(tableId);
      for (const id of [orderId, otherOrderId]) db.prepare("INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, ?, 'dine_in', ?, ?, 0)")
        .run(id, randomUUID(), tableId, userId);
      const requestItems = JSON.stringify(Array.from({ length: 30 }, () => ({ productId, variantId: null, name: "Original rice bowl", pricePaise: 9000, gstRate: 5, qty: 2, note: "" })));
      for (const [id, status, order] of [[requestId, "accepted", orderId], [pendingId, "pending", null]] as const) {
        db.prepare(`INSERT INTO guest_requests (id, client_ref, table_id, table_name, receipt_hash, fingerprint, items_json, subtotal_paise,
          tax_inclusive, status, created_at, expires_at, order_id) VALUES (?, ?, ?, 'T1', 'hash', 'fingerprint', ?, 540000, 0, ?, 0, 1000, ?)`).run(id, randomUUID(), tableId, requestItems, status, order);
      }
      const rows = [
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:0`, expected: requestId },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:29`, expected: requestId },
        { id: randomUUID(), order: otherOrderId, ref: `guest:${requestId}:1`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${pendingId}:0`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${randomUUID()}:0`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}junk`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:0junk`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:30`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:01`, expected: null },
        { id: randomUUID(), order: orderId, ref: `guest:${requestId}:-1`, expected: null },
        { id: randomUUID(), order: orderId, ref: randomUUID(), expected: null },
      ];
      for (const row of rows) db.prepare(`INSERT INTO order_items (id, order_id, client_ref, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty)
        VALUES (?, ?, ?, ?, 'Original rice bowl', 9000, 5, 2)`).run(row.id, row.order, row.ref, productId);
      const before = db.prepare("SELECT id, order_id, client_ref, name_snapshot, price_paise_snapshot, qty FROM order_items ORDER BY id").all();
      const throughTen = MIGRATIONS.filter((migration) => migration.version <= 10);
      migrate(db, throughTen); migrate(db, throughTen);
      expect(db.prepare("SELECT description, is_sold_out, photo_data, photo_hash FROM products WHERE id = ?").get(productId))
        .toEqual({ description: "", is_sold_out: 0, photo_data: null, photo_hash: null });
      expect(db.prepare("SELECT id, order_id, client_ref, name_snapshot, price_paise_snapshot, qty FROM order_items ORDER BY id").all()).toEqual(before);
      for (const row of rows) expect(db.prepare("SELECT guest_request_id FROM order_items WHERE id = ?").get(row.id), row.ref).toEqual({ guest_request_id: row.expected });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
