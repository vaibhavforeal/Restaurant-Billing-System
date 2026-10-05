import { createHash, randomBytes } from "node:crypto";
import { GuestSubmission, nextSplitLabel, uuidv7, type Database, type GuestMenu, type GuestReceipt, type GuestRequest, type GuestRequestItem, type QrTable, type GuestPreparation, type PreparationState } from "@forkflow/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { assertTableNotReserved } from "./reservation-rules.js";
import { httpError } from "./http-error.js";
import { loadOrderJson, type OrderRow } from "./mappers.js";
import { lanUrls } from "./system.js";
import { menuPhotoUrl } from "./menu-photo.js";

const idParams = z.object({ id: z.string().uuid() });
const TTL = 2 * 60 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credential = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
interface TableRow { price_tier: "non_ac" | "ac"; id: string; name: string; area: string | null; is_active: number; enabled: number | null; token: string | null }
interface RequestRow {
  id: string; client_ref: string; table_id: string; table_name: string; receipt_hash: string; fingerprint: string;
  items_json: string; subtotal_paise: number; tax_inclusive: number; status: GuestReceipt["status"];
  created_at: number; expires_at: number; reason: string | null; order_id: string | null;
  reviewed_at: number | null; reviewed_by: string | null; decision_json: string | null; reviewer_name: string | null;
}
function preparation(db: Database, request: RequestRow): GuestPreparation | null {
  if (request.status !== "accepted") return null;
  const rows = db.prepare(`SELECT i.name_snapshot, i.qty, i.status, i.note, i.client_ref, i.kot_id, k.done_at,
    p.kot_station_id, o.status AS order_status FROM order_items i
    JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
    LEFT JOIN kots k ON k.id = i.kot_id
    WHERE i.guest_request_id = ? AND i.order_id = ? ORDER BY i.id`).all(request.id, request.order_id) as Array<{
      name_snapshot: string; qty: number; status: string; note: string | null; client_ref: string;
      kot_id: string | null; done_at: number | null; kot_station_id: string | null; order_status: string;
    }>;
  const original = JSON.parse(request.items_json) as GuestRequestItem[];
  let hasChanges = rows.length !== original.length;
  const items = rows.map((row) => {
    const index = Number(row.client_ref.slice(`guest:${request.id}:`.length));
    const before = original[index];
    if (!before || before.qty !== row.qty || before.name !== row.name_snapshot || before.note !== (row.note ?? "")) hasChanges = true;
    const state: PreparationState = row.status === "cancelled" || row.order_status === "cancelled" ? "cancelled"
      : row.kot_id ? row.done_at !== null ? "ready" : "preparing"
      : row.kot_station_id ? "queued" : "with_staff";
    if (state === "cancelled") hasChanges = true;
    return { name: row.name_snapshot, qty: row.qty, state };
  });
  const active = items.filter((item) => item.state !== "cancelled");
  const state: PreparationState = items.length === 0 ? "with_staff" : active.length === 0 ? "cancelled"
    : active.every((item) => item.state === "ready") ? "ready"
    : active.some((item) => item.state === "preparing") ? "preparing"
    : active.some((item) => item.state === "with_staff") ? "with_staff" : "queued";
  return { state, items, hasChanges };
}
const receiptJson = (db: Database, r: RequestRow): GuestReceipt => ({
  id: r.id, status: r.status, tableName: r.table_name, items: JSON.parse(r.items_json) as GuestRequestItem[],
  subtotalPaise: r.subtotal_paise, taxInclusive: r.tax_inclusive === 1, createdAt: r.created_at,
  expiresAt: r.expires_at, reason: r.reason, preparation: preparation(db, r),
});
const requestJson = (db: Database, r: RequestRow): GuestRequest => ({ ...receiptJson(db, r), tableId: r.table_id, orderId: r.order_id,
  reviewedAt: r.reviewed_at, reviewedByName: r.reviewer_name });
const tableJson = (r: TableRow): QrTable => ({ id: r.id, name: r.name, area: r.area, isActive: r.is_active === 1,
  enabled: r.enabled === 1, path: r.token ? `/menu#${r.token}` : null });

export function registerGuestOrdering(app: FastifyInstance, port = 4100) {
  const tableSql = "SELECT t.*, q.enabled, q.token FROM dining_tables t LEFT JOIN table_qr q ON q.table_id = t.id";
  const requestSql = "SELECT r.*, u.name AS reviewer_name FROM guest_requests r LEFT JOIN users u ON u.id = r.reviewed_by";
  const getRequest = (id: string) => app.db.prepare(`${requestSql} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  const getTable = (id: string) => app.db.prepare(`${tableSql} WHERE t.id = ?`).get(id) as TableRow | undefined;
  const origins = () => [...lanUrls(port), `http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const changed = () => app.broadcast("guest-request.changed", {});
  function expire() {
    const result = app.db.prepare("UPDATE guest_requests SET status = 'expired', reason = 'This request expired before staff accepted it.' WHERE status = 'pending' AND expires_at <= ?").run(Date.now());
    if (result.changes) changed();
  }

  // Bounded, server-local protection. A restaurant Wi-Fi shares an IP, so reads
  // have a higher allowance than submissions; pending requests are also capped.
  const rates = new Map<string, { until: number; count: number }>();
  function rate(req: FastifyRequest, action: string, limit: number) {
    const now = Date.now(), key = `${action}:${req.ip}`;
    if (rates.size >= 10_000) {
      for (const [k, value] of rates) if (value.until <= now) rates.delete(k);
      if (rates.size >= 10_000 && !rates.has(key)) throw httpError(429, "Please wait a minute and try again");
    }
    let value = rates.get(key);
    if (!value || value.until <= now) { value = { until: now + 60_000, count: 0 }; rates.set(key, value); }
    if (++value.count > limit) throw httpError(429, "Please wait a minute and try again");
  }
  // Guest capabilities never call requireAuth or register a staff device.
  function guestLicense(ordering = false) {
    const status = app.licensing.status();
    if (!["development", "active", "grace"].includes(status.state)) throw httpError(403, "The restaurant menu is temporarily unavailable. Please ask a member of staff.");
    if (ordering && !status.features.qrOrdering) throw httpError(403, "Please ask a member of staff to place your order.");
    return status.features.qrOrdering;
  }
  function qrTable(req: FastifyRequest) {
    const token = credential(req.headers["x-qr-token"]);
    const row = token ? app.db.prepare(`${tableSql} WHERE q.token = ? AND q.enabled = 1 AND t.is_active = 1`).get(token) as TableRow | undefined : undefined;
    if (!row) throw httpError(404, "This table menu is unavailable. Please ask a member of staff.");
    return row;
  }
  function menu(table: TableRow, orderingAvailable: boolean): GuestMenu {
    const settings = app.db.prepare("SELECT restaurant_name, tax_inclusive FROM settings WHERE id = 1").get() as { restaurant_name: string; tax_inclusive: number };
    const categories = app.db.prepare("SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, name, id").all() as GuestMenu["categories"];
    const products = app.db.prepare(`SELECT p.id, p.category_id AS categoryId, p.name, CASE WHEN ? = 'ac' THEN COALESCE(p.ac_price_paise, p.price_paise) ELSE p.price_paise END AS pricePaise,
      p.gst_rate AS gstRate, p.is_veg, p.description, p.is_sold_out, p.photo_hash FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1 AND c.is_active = 1 ORDER BY p.name, p.id`).all(table.price_tier) as Array<Omit<GuestMenu["products"][number], "isVeg" | "variants" | "photoUrl" | "isSoldOut"> & { is_veg: number; is_sold_out: number; photo_hash: string | null }>;
    const variants = app.db.prepare("SELECT id, product_id, name, CASE WHEN ? = 'ac' THEN COALESCE(ac_price_paise, price_paise) ELSE price_paise END AS pricePaise FROM variants WHERE is_active = 1 ORDER BY name, id").all(table.price_tier) as Array<{ id: string; product_id: string; name: string; pricePaise: number }>;
    const byProduct = new Map<string, GuestMenu["products"][number]["variants"]>();
    for (const v of variants) { const list = byProduct.get(v.product_id) ?? []; list.push({ id: v.id, name: v.name, pricePaise: v.pricePaise }); byProduct.set(v.product_id, list); }
    const visible = products.map(({ is_veg, is_sold_out, photo_hash, ...p }) => ({ ...p, isVeg: is_veg === 1, isSoldOut: is_sold_out === 1, photoUrl: menuPhotoUrl(p.id, photo_hash), variants: byProduct.get(p.id) ?? [] }));
    const snapshot = { taxInclusive: settings.tax_inclusive === 1, categories, products: visible };
    const pricing = { ...snapshot, products: visible.map(({ description: _description, photoUrl: _photoUrl, ...p }) => p) };
    return { restaurantName: settings.restaurant_name, table: { id: table.id, name: table.name, area: table.area },
      orderingAvailable, menuVersion: hash(JSON.stringify(pricing)), ...snapshot };
  }
  function snapshotItems(current: GuestMenu, items: GuestSubmission["items"]): GuestRequestItem[] {
    return items.map((item) => {
      const product = current.products.find((p) => p.id === item.productId);
      const variant = item.variantId ? product?.variants.find((v) => v.id === item.variantId) : undefined;
      if (!product || product.isSoldOut || (item.variantId && !variant) || (!item.variantId && product.variants.length)) {
        throw httpError(409, "An item or option is no longer available. Review the menu and submit again.", "menu_changed");
      }
      return { ...item, name: variant ? `${product.name} (${variant.name})` : product.name,
        pricePaise: variant?.pricePaise ?? product.pricePaise, gstRate: product.gstRate };
    });
  }

  app.get("/api/guest/menu", async (req, reply) => {
    reply.header("Cache-Control", "no-store"); rate(req, "menu", 240);
    return menu(qrTable(req), guestLicense());
  });
  app.post("/api/guest/requests", { bodyLimit: 32_768 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); rate(req, "submit", 30);
    const body = GuestSubmission.parse(req.body);
    const fingerprint = hash(JSON.stringify({ ...body, qrToken: credential(req.headers["x-qr-token"]) }));
    expire();
    const existing = app.db.prepare(`${requestSql} WHERE r.client_ref = ?`).get(body.clientRef) as RequestRow | undefined;
    if (existing) {
      if (existing.receipt_hash !== hash(body.receiptToken)) throw httpError(404, "Request not found");
      if (existing.fingerprint !== fingerprint) throw httpError(409, "This request reference was already used. Check its status before placing another request.");
      return { request: receiptJson(app.db, existing) };
    }
    guestLicense(true);
    const table = qrTable(req), current = menu(table, true);
    if (current.menuVersion !== body.menuVersion) throw httpError(409, "The menu has changed. Review the latest prices before submitting again.", "menu_changed");
    const items = snapshotItems(current, body.items);
    const id = uuidv7(), now = Date.now();
    app.db.transaction(() => {
      const pending = app.db.prepare("SELECT COUNT(*) AS n FROM guest_requests WHERE table_id = ? AND status = 'pending'").get(table.id) as { n: number };
      if (pending.n >= 10) throw httpError(429, "This table has several requests awaiting review. Please ask a member of staff.");
      app.db.prepare(`INSERT INTO guest_requests (id, client_ref, table_id, table_name, receipt_hash, fingerprint, items_json, subtotal_paise, tax_inclusive, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.clientRef, table.id, table.name, hash(body.receiptToken), fingerprint,
          JSON.stringify(items), items.reduce((sum, i) => sum + i.pricePaise * i.qty, 0), current.taxInclusive ? 1 : 0, now, now + TTL);
    })();
    changed();
    return reply.status(201).send({ request: receiptJson(app.db, getRequest(id)!) });
  });
  app.get("/api/guest/requests/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store"); rate(req, "receipt", 600);
    const { id } = idParams.parse(req.params), token = credential(req.headers["x-guest-receipt"]);
    expire();
    const row = getRequest(id);
    if (!row || !token || row.receipt_hash !== hash(token)) throw httpError(404, "Request not found");
    return { request: receiptJson(app.db, row) };
  });

  const manage = app.requirePermission("tables.manage");
  app.get("/api/qr/tables", { preHandler: manage }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { tables: (app.db.prepare(`${tableSql} ORDER BY t.sort_order, t.name`).all() as TableRow[]).map(tableJson), origins: origins() };
  });
  app.put("/api/qr/tables/:id", { preHandler: manage }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { id } = idParams.parse(req.params);
    const body = z.object({ enabled: z.boolean(), rotate: z.boolean().optional() }).strict().parse(req.body);
    const row = getTable(id);
    if (!row) throw httpError(404, "Table not found");
    const token = !row.token || body.rotate ? randomBytes(32).toString("hex") : row.token;
    app.db.prepare(`INSERT INTO table_qr (table_id, token, enabled) VALUES (?, ?, ?)
      ON CONFLICT(table_id) DO UPDATE SET token = excluded.token, enabled = excluded.enabled`).run(id, token, body.enabled ? 1 : 0);
    app.broadcast("table.changed", { tableId: id });
    return { table: tableJson(getTable(id)!) };
  });
  app.get("/api/qr/tables/:id/image", { preHandler: manage }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { id } = idParams.parse(req.params), { origin } = z.object({ origin: z.string().max(200) }).parse(req.query);
    if (!origins().includes(origin)) throw httpError(400, "Choose a current restaurant server address");
    const table = getTable(id);
    if (!table?.token || !table.enabled || !table.is_active) throw httpError(409, "Enable an active table's QR menu first");
    const url = `${origin}/menu#${table.token}`;
    return { url, qr: await QRCode.toDataURL(url, { width: 360, margin: 4, errorCorrectionLevel: "M" }) };
  });

  app.get("/api/qr/requests", { preHandler: app.requirePermission("orders.read") }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); expire();
    const { status } = z.object({ status: z.enum(["pending", "accepted", "rejected", "expired", "all"]).default("pending") }).parse(req.query);
    const rows = status === "all" ? app.db.prepare(`${requestSql} ORDER BY r.created_at DESC LIMIT 500`).all()
      : app.db.prepare(`${requestSql} WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 500`).all(status);
    return { requests: (rows as RequestRow[]).map((row) => requestJson(app.db, row)) };
  });
  app.post("/api/qr/requests/:id/reject", { preHandler: app.requirePermission("orders.update") }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    expire();
    const row = getRequest(id);
    if (!row) throw httpError(404, "Request not found");
    if (row.status === "rejected" && row.reason === reason) return { request: requestJson(app.db, row) };
    if (row.status !== "pending") throw httpError(409, "This request has already been reviewed or expired");
    app.db.prepare("UPDATE guest_requests SET status = 'rejected', reason = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .run(reason, Date.now(), req.user.id, id);
    changed(); return { request: requestJson(app.db, getRequest(id)!) };
  });
  app.post("/api/qr/requests/:id/accept", { preHandler: [app.requirePermission("orders.update"), app.requirePermission("orders.create"), app.requireFeature("qrOrdering")] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z.object({ orderId: z.string().uuid().nullable() }).strict().parse(req.body);
    const decision = JSON.stringify(body);
    expire();
    let didAccept = false;
    const orderId = app.db.transaction(() => {
      const row = getRequest(id);
      if (!row) throw httpError(404, "Request not found");
      if (row.status === "accepted" && row.decision_json === decision) return row.order_id!;
      if (row.status !== "pending") throw httpError(409, "This request has already been reviewed or expired");
      const table = getTable(row.table_id);
      if (!table?.is_active) throw httpError(409, "The table is no longer active");
      const items = JSON.parse(row.items_json) as GuestRequestItem[], current = menu(table, true);
      const latest = snapshotItems(current, items.map(({ productId, variantId, qty, note }) => ({ productId, variantId, qty, note })));
      if (JSON.stringify(latest) !== JSON.stringify(items) || current.taxInclusive !== (row.tax_inclusive === 1)) {
        throw httpError(409, "The requested items or prices have changed. Reject this request and ask the customer to review the menu.", "menu_changed");
      }
      const now = Date.now(), target = body.orderId ?? uuidv7();
      if (body.orderId) {
        const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(target) as OrderRow | undefined;
        if (!order || order.type !== "dine_in" || order.table_id !== row.table_id || order.status !== "open") {
          throw httpError(409, "Choose an open bill at this table, or create a new bill group");
        }
        if (order.price_tier !== table.price_tier) throw httpError(409, "This bill uses different pricing. Create a new bill group.");
      } else {
        assertTableNotReserved(app.db, row.table_id, now);
        const label = nextSplitLabel(app.db, row.table_id);
        if (label === null) throw httpError(409, "This table has too many open bill groups");
        app.db.prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier) VALUES (?, ?, 'dine_in', ?, ?, ?, ?, ?)")
          .run(target, `guest:${id}`, row.table_id, label, req.user.id, now, table.price_tier);
      }
      for (const [index, item] of items.entries()) {
        app.db.prepare(`INSERT INTO order_items (id, order_id, client_ref, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, note, guest_request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv7(), target, `guest:${id}:${index}`, item.productId, item.variantId, item.name, item.pricePaise, item.gstRate, item.qty, item.note || null, id);
      }
      app.db.prepare("UPDATE guest_requests SET status = 'accepted', order_id = ?, reviewed_at = ?, reviewed_by = ?, decision_json = ? WHERE id = ?")
        .run(target, now, req.user.id, decision, id);
      didAccept = true; return target;
    })();
    const request = requestJson(app.db, getRequest(id)!), order = loadOrderJson(app.db, orderId)!;
    if (didAccept) { changed(); app.broadcast("order.updated", { order }); app.broadcast("table.changed", { tableId: request.tableId }); }
    return { request, order };
  });
}
