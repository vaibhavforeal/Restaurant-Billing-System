import { createHash, randomBytes } from "node:crypto";
import { AddonPickError, ComboPickError, GuestSubmission, addonsAvailable, comboAvailable, resolveAddonPicks, type GuestAddonGroup, effectiveGstRate, nextSplitLabel, resolveComboPicks, uuidv7, type Database, type GuestMenu, type GuestReceipt, type GuestRequest, type GuestRequestItem, type QrTable, type GuestPreparation, type PreparationState } from "@masalapos/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { assertTableNotReserved } from "./reservation-rules.js";
import { httpError } from "./http-error.js";
import { guestRateLimiter } from "./guest-rate.js";
import { loadOrderJson, type OrderRow } from "./mappers.js";
import { lanUrls } from "./system.js";
import { menuPhotoUrl } from "./menu-photo.js";
import { readGstSettings } from "./gst-settings.js";
import { moduleActive, requireModule } from "./modules.js";
import { comboGroupsByCombo } from "./combos.js";
import { addonGroupsByProduct } from "./addon-groups.js";
import { insertOrderItem, priceOrderItem } from "./order-items.js";
import { menuPairs, menuPopularIds } from "./menu-insights.js";

const idParams = z.object({ id: z.string().uuid() });
const TTL = 2 * 60 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credential = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
interface TableRow { price_tier: "non_ac" | "ac"; id: string; name: string; area: string | null; is_active: number; enabled: number | null; token: string | null }
interface RequestRow {
  id: string; client_ref: string; table_id: string; table_name: string; receipt_hash: string; fingerprint: string;
  items_json: string; subtotal_paise: number; status: GuestReceipt["status"];
  created_at: number; expires_at: number; reason: string | null; order_id: string | null;
  reviewed_at: number | null; reviewed_by: string | null; decision_json: string | null; reviewer_name: string | null;
}
function preparation(db: Database, request: RequestRow): GuestPreparation | null {
  if (request.status !== "accepted") return null;
  type Row = {
    id: string; name_snapshot: string; qty: number; status: string; note: string | null; client_ref: string | null; parent_item_id: string | null;
    kot_id: string | null; done_at: number | null; kot_station_id: string | null; order_status: string;
  };
  const select = `SELECT i.id, i.name_snapshot, i.qty, i.status, i.note, i.client_ref, i.parent_item_id, i.kot_id, k.done_at,
    p.kot_station_id, o.status AS order_status FROM order_items i
    JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
    LEFT JOIN kots k ON k.id = i.kot_id`;
  const rows = db.prepare(`${select} WHERE i.guest_request_id = ? AND i.order_id = ? ORDER BY i.id`).all(request.id, request.order_id) as Row[];
  // A combo is as far along as the items in it.
  const inCombos = db.prepare(`${select} WHERE i.parent_item_id IN (SELECT id FROM order_items WHERE guest_request_id = ? AND order_id = ?) ORDER BY i.id`)
    .all(request.id, request.order_id) as Row[];
  // A dish is as far along as itself and its add-ons together; a drink add-on still at the bar keeps it preparing.
  const addons = db.prepare(`${select.replace("i.parent_item_id,", "i.parent_item_id, i.addon_of_item_id,")} WHERE i.addon_of_item_id IN (SELECT id FROM order_items WHERE guest_request_id = ? AND order_id = ?) ORDER BY i.id`)
    .all(request.id, request.order_id) as Array<Row & { addon_of_item_id: string }>;
  const rowState = (row: Row): PreparationState => row.status === "cancelled" || row.order_status === "cancelled" ? "cancelled"
    : row.kot_id ? row.done_at !== null ? "ready" : "preparing"
    : row.kot_station_id ? "queued" : "with_staff";
  const original = JSON.parse(request.items_json) as GuestRequestItem[];
  let hasChanges = rows.length !== original.length;
  const items = rows.map((row) => {
    const index = row.client_ref === null ? -1 : Number(row.client_ref.slice(`guest:${request.id}:`.length));
    const before = original[index];
    if (!before || before.qty !== row.qty || before.name !== row.name_snapshot || before.note !== (row.note ?? "")) hasChanges = true;
    const held = inCombos.filter((item) => item.parent_item_id === row.id);
    const picked = addons.filter((item) => item.addon_of_item_id === row.id);
    // Staff cancelling an add-on the guest picked is a change to what they asked for.
    if (picked.some((item) => item.status === "cancelled")) hasChanges = true;
    const own = held.length && rowState(row) !== "cancelled" ? overallState(held.map(rowState)) : rowState(row);
    const state = picked.length && own !== "cancelled" ? overallState([own, ...picked.map(rowState)]) : own;
    if (state === "cancelled") hasChanges = true;
    return { name: row.name_snapshot, qty: row.qty, state };
  });
  return { state: overallState(items.map((item) => item.state)), items, hasChanges };
}
function overallState(states: PreparationState[]): PreparationState {
  const active = states.filter((state) => state !== "cancelled");
  return states.length === 0 ? "with_staff" : active.length === 0 ? "cancelled"
    : active.every((state) => state === "ready") ? "ready"
    : active.some((state) => state === "preparing") ? "preparing"
    : active.some((state) => state === "with_staff") ? "with_staff" : "queued";
}
const receiptJson = (db: Database, r: RequestRow): GuestReceipt => ({
  id: r.id, status: r.status, tableName: r.table_name, items: JSON.parse(r.items_json) as GuestRequestItem[],
  subtotalPaise: r.subtotal_paise, createdAt: r.created_at,
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
  const rate = guestRateLimiter();
  // Guest capabilities never call requireAuth or register a staff device.
  function guestLicense(ordering = false) {
    const status = app.licensing.status();
    if (!["development", "active", "grace"].includes(status.state)) throw httpError(403, "The restaurant menu is temporarily unavailable. Please ask a member of staff.");
    const qrOrdering = moduleActive(app.db, "qrOrdering");
    if (ordering && !qrOrdering) throw httpError(403, "Please ask a member of staff to place your order.");
    return qrOrdering;
  }
  function qrTable(req: FastifyRequest) {
    const token = credential(req.headers["x-qr-token"]);
    const row = token ? app.db.prepare(`${tableSql} WHERE q.token = ? AND q.enabled = 1 AND t.is_active = 1`).get(token) as TableRow | undefined : undefined;
    if (!row) throw httpError(404, "This table menu is unavailable. Please ask a member of staff.");
    return row;
  }
  function menu(table: TableRow, orderingAvailable: boolean): GuestMenu {
    const settings = app.db.prepare("SELECT restaurant_name FROM settings WHERE id = 1").get() as { restaurant_name: string };
    const { gstRate: defaultRate } = readGstSettings(app.db);
    const categories = app.db.prepare("SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, name, id").all() as GuestMenu["categories"];
    const products = app.db.prepare(`SELECT p.id, p.category_id AS categoryId, p.name, CASE WHEN ? = 'ac' THEN COALESCE(p.ac_price_paise, p.price_paise) ELSE p.price_paise END AS pricePaise,
      p.gst_rate AS itemGstRate, p.is_veg, p.description, p.is_sold_out, p.photo_hash, p.kind, p.addon_only FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1 AND c.is_active = 1 ORDER BY p.name, p.id`).all(table.price_tier) as Array<Omit<GuestMenu["products"][number], "isVeg" | "variants" | "photoUrl" | "isSoldOut" | "gstRate" | "combo" | "addonGroups"> & { itemGstRate: number | null; is_veg: number; is_sold_out: number; photo_hash: string | null; kind: "item" | "combo"; addon_only: number }>;
    const combos = comboGroupsByCombo(app.db);
    const variants = app.db.prepare("SELECT id, product_id, name, CASE WHEN ? = 'ac' THEN COALESCE(ac_price_paise, price_paise) ELSE price_paise END AS pricePaise FROM variants WHERE is_active = 1 ORDER BY name, id").all(table.price_tier) as Array<{ id: string; product_id: string; name: string; pricePaise: number }>;
    const byProduct = new Map<string, GuestMenu["products"][number]["variants"]>();
    for (const v of variants) { const list = byProduct.get(v.product_id) ?? []; list.push({ id: v.id, name: v.name, pricePaise: v.pricePaise }); byProduct.set(v.product_id, list); }
    const addons = guestAddonGroups(table.price_tier);
    // A combo with no slots yet is left off; one that cannot be filled right now shows as sold out. Add-on-only products
    // are picked under a dish, so they are not listed; a dish whose required add-ons cannot be picked is sold out.
    const visible = products.filter((p) => (p.kind !== "combo" || combos.has(p.id)) && p.addon_only !== 1).map(({ is_veg, is_sold_out, photo_hash, itemGstRate, kind, addon_only: _addonOnly, ...p }) => {
      const combo = kind === "combo" ? combos.get(p.id)! : null;
      const addonGroups = addons.get(p.id);
      const addonsBlocked = !!addonGroups && !addonsAvailable(addonGroups.map((g) => ({ ...g, isActive: true })));
      return { ...p, gstRate: effectiveGstRate(itemGstRate, defaultRate), isVeg: is_veg === 1,
        isSoldOut: is_sold_out === 1 || (combo !== null && !comboAvailable(combo)) || addonsBlocked,
        photoUrl: menuPhotoUrl(p.id, photo_hash), variants: byProduct.get(p.id) ?? [], ...(combo ? { combo } : {}), ...(addonGroups ? { addonGroups } : {}) };
    });
    // Prices never have tax added on top, and the version covers every effective rate.
    const snapshot = { categories, products: visible };
    const pricing = { ...snapshot, products: visible.map(({ description: _description, photoUrl: _photoUrl, ...p }) => p) };
    return { restaurantName: settings.restaurant_name, table: { id: table.id, name: table.name, area: table.area },
      orderingAvailable, menuVersion: hash(JSON.stringify(pricing)), ...snapshot,
      // Hints only: kept out of the version so a change in what sells never asks guests to review their cart.
      popularProductIds: menuPopularIds(app.db), pairs: menuPairs(app.db) };
  }
  /** Each dish's active add-on groups with the add-ons priced for the table's tier; dishes without any are left out. */
  function guestAddonGroups(tier: string): Map<string, GuestAddonGroup[]> {
    const priceSql = (table: string) => `SELECT id, CASE WHEN ? = 'ac' THEN COALESCE(ac_price_paise, price_paise) ELSE price_paise END AS price${table === "products" ? ", is_veg" : ""} FROM ${table}`;
    const prices = new Map((app.db.prepare(priceSql("products")).all(tier) as Array<{ id: string; price: number; is_veg: number }>).map((r) => [r.id, r]));
    const variantPrices = new Map((app.db.prepare(priceSql("variants")).all(tier) as Array<{ id: string; price: number }>).map((r) => [r.id, r.price]));
    const result = new Map<string, GuestAddonGroup[]>();
    for (const [productId, groups] of addonGroupsByProduct(app.db)) {
      const active: GuestAddonGroup[] = groups.filter((g) => g.isActive).map((g) => ({ id: g.id, name: g.name, minPicks: g.minPicks, maxPicks: g.maxPicks,
        options: g.options.map((o) => ({ id: o.id, productId: o.productId, variantId: o.variantId, name: o.name,
          pricePaise: (o.variantId ? variantPrices.get(o.variantId) : undefined) ?? prices.get(o.productId)!.price,
          isVeg: prices.get(o.productId)!.is_veg === 1, ...(o.unavailable ? { unavailable: true as const } : {}) })) }));
      if (active.length) result.set(productId, active);
    }
    return result;
  }
  function snapshotItems(current: GuestMenu, items: GuestSubmission["items"]): GuestRequestItem[] {
    return items.map((item) => {
      const product = current.products.find((p) => p.id === item.productId);
      const variant = item.variantId ? product?.variants.find((v) => v.id === item.variantId) : undefined;
      if (!product || product.isSoldOut || (item.variantId && !variant) || (!item.variantId && product.variants.length) || (!product.combo && item.comboPicks)
        || (product.combo && item.addonPicks?.length)) {
        throw httpError(409, "An item or option is no longer available. Review the menu and submit again.", "menu_changed");
      }
      if (product.combo) {
        let chosen;
        try { chosen = resolveComboPicks(product.combo, item.comboPicks ?? []); }
        catch (err) { if (err instanceof ComboPickError) throw httpError(409, `${product.name}: ${err.message}`, "menu_changed"); throw err; }
        return { ...item, name: product.name, pricePaise: product.pricePaise + chosen.extraPaise, gstRate: product.gstRate,
          contents: chosen.items.map((held) => held.qty > 1 ? `${held.qty} x ${held.name}` : held.name) };
      }
      if (!product.addonGroups && item.addonPicks?.length) throw httpError(409, "An item or option is no longer available. Review the menu and submit again.", "menu_changed");
      let addons: Array<{ name: string; pricePaise: number }> = [];
      if (product.addonGroups) {
        try {
          const chosen = resolveAddonPicks(product.addonGroups.map((g) => ({ ...g, isActive: true })), item.addonPicks ?? []);
          const priced = new Map(product.addonGroups.flatMap((g) => g.options).map((o) => [o.id, o.pricePaise]));
          addons = chosen.map((choice) => ({ name: choice.name, pricePaise: priced.get(choice.id)! }));
        } catch (err) { if (err instanceof AddonPickError) throw httpError(409, `${product.name}: ${err.message}`, "menu_changed"); throw err; }
      }
      return { ...item, name: variant ? `${product.name} (${variant.name})` : product.name,
        pricePaise: variant?.pricePaise ?? product.pricePaise, gstRate: product.gstRate, ...(addons.length ? { addons } : {}) };
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
      app.db.prepare(`INSERT INTO guest_requests (id, client_ref, table_id, table_name, receipt_hash, fingerprint, items_json, subtotal_paise, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.clientRef, table.id, table.name, hash(body.receiptToken), fingerprint,
          JSON.stringify(items), items.reduce((sum, i) => sum + (i.pricePaise + (i.addons ?? []).reduce((n, a) => n + a.pricePaise, 0)) * i.qty, 0), now, now + TTL);
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
  app.post("/api/qr/requests/:id/accept", { preHandler: [app.requirePermission("orders.update"), app.requirePermission("orders.create"), requireModule(app, "qrOrdering")] }, async (req) => {
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
      const latest = snapshotItems(current, items.map(({ productId, variantId, qty, note, comboPicks, addonPicks }) => ({ productId, variantId, qty, note, ...(comboPicks ? { comboPicks } : {}), ...(addonPicks ? { addonPicks } : {}) })));
      if (JSON.stringify(latest) !== JSON.stringify(items)) {
        throw httpError(409, "The requested items or prices have changed. Reject this request and ask the customer to review the menu.", "menu_changed");
      }
      const now = Date.now(), target = body.orderId ?? uuidv7();
      if (body.orderId) {
        const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(target) as OrderRow | undefined;
        // A table linked to a combined order may add to it; the order is open, so the link is active.
        const atThisTable = order?.table_id === row.table_id
          || !!app.db.prepare("SELECT 1 FROM table_links WHERE table_id = ? AND order_id = ?").get(row.table_id, target);
        if (!order || order.type !== "dine_in" || !atThisTable || order.status !== "open") {
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
        insertOrderItem(app.db, target, priceOrderItem(app.db, table.price_tier, item), { clientRef: `guest:${id}:${index}`, guestRequestId: id });
      }
      app.db.prepare("UPDATE guest_requests SET status = 'accepted', order_id = ?, reviewed_at = ?, reviewed_by = ?, decision_json = ? WHERE id = ?")
        .run(target, now, req.user.id, decision, id);
      didAccept = true; return target;
    })();
    const request = requestJson(app.db, getRequest(id)!), order = loadOrderJson(app.db, orderId)!;
    if (didAccept) {
      changed(); app.broadcast("order.updated", { order }); app.broadcast("table.changed", { tableId: request.tableId });
      if (order.tableId && order.tableId !== request.tableId) app.broadcast("table.changed", { tableId: order.tableId });
    }
    return { request, order };
  });
}
