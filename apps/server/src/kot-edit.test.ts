import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("KOT edit after send", () => {
  let app: FastifyInstance; let token: string; let productId: string; let stockId: string;
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Paneer", categoryId: c.json().category.id, pricePaise: 10000, gstRate: 5, kotStationId: station.id } });
    productId = p.json().product.id;
    const printer = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 } });
    await app.inject({ method: "PATCH", url: `/api/kot-stations/${station.id}`, headers: auth(token), payload: { printerId: printer.json().printer.id } });
    const s = await app.inject({ method: "POST", url: "/api/stock-items", headers: auth(token), payload: { clientRef: uuidv7(), name: "Paneer block", unit: "kg", openingQty: 10, lowStockThreshold: null } });
    stockId = s.json().item.id;
    const links = (await app.inject({ url: `/api/products/${productId}/stock-links`, headers: auth(token) })).json();
    await app.inject({ method: "PUT", url: `/api/products/${productId}/stock-links`, headers: auth(token), payload: { expectedVersion: links.version, stockItemId: stockId, qtyPerSale: 0.2 } });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const balance = () => (app.db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(stockId) as { qty: number }).qty;
  const editJobs = () => (app.db.prepare("SELECT job_json FROM print_jobs").all() as Array<{ job_json: string }>).map((r) => JSON.parse(r.job_json)).filter((j) => j.kind === "edit");
  const edit = (itemId: string, payload: Record<string, unknown>, as = token) =>
    app.inject({ method: "POST", url: `/api/order-items/${itemId}/edit-sent`, headers: auth(as), payload: { clientRef: uuidv7(), ...payload } });
  async function sentItem(qty: number) {
    const o = (await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel" } })).json().order;
    const added = await app.inject({ method: "POST", url: `/api/orders/${o.id}/items`, headers: auth(token), payload: { items: [{ productId, qty, clientRef: uuidv7() }] } });
    const itemId = added.json().order.items[0].id as string;
    expect((await app.inject({ method: "POST", url: `/api/orders/${o.id}/send`, headers: auth(token) })).statusCode).toBe(200);
    return { orderId: o.id as string, itemId };
  }

  it("cuts the quantity: removed units become a cancelled item, stock comes back, the kitchen gets a slip", async () => {
    const { orderId, itemId } = await sentItem(3);
    expect(balance()).toBe(9.4);
    const res = await edit(itemId, { qty: 1, reason: "Guest changed mind" });
    expect(res.statusCode).toBe(200);
    const items = res.json().order.items as Array<{ id: string; qty: number; status: string; cancelReason: string | null }>;
    expect(items.find((i) => i.id === itemId)).toMatchObject({ qty: 1, status: "sent" });
    expect(items.find((i) => i.id !== itemId)).toMatchObject({ qty: 2, status: "cancelled", cancelReason: "Guest changed mind" });
    expect(balance()).toBe(9.8);
    expect(editJobs()).toHaveLength(1);
    expect(editJobs()[0].label).toContain("Changed");
    expect(app.db.prepare("SELECT old_qty, new_qty, printed FROM kot_edits").get()).toEqual({ old_qty: 3, new_qty: 1, printed: 1 });
    // A later full cancel returns only what is still on the order.
    expect((await app.inject({ method: "POST", url: `/api/order-items/${itemId}/cancel`, headers: auth(token), payload: { reason: "Left" } })).statusCode).toBe(200);
    expect(balance()).toBe(10);
    expect(app.db.prepare("SELECT order_id FROM order_items WHERE id = ?").get(itemId)).toEqual({ order_id: orderId });
  });

  it("bills only the kept quantity and the profit report costs only what was served", async () => {
    // ₹1,000 a kg, so each 0.2 kg portion costs ₹200.
    app.db.prepare("UPDATE stock_items SET unit_cost_milli_paise = 100000000 WHERE id = ?").run(stockId);
    const { orderId, itemId } = await sentItem(4);
    expect((await edit(itemId, { qty: 3, reason: "Wrong count" })).statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload: {} });
    expect(preview.json().preview.subtotalPaise).toBe(30000);
    const bill = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    expect((bill.json().bill as Bill).totalPaise).toBe(30000);
    const net = app.db.prepare("SELECT SUM(delta) AS d FROM stock_moves WHERE stock_item_id = ? AND reason IN ('sale', 'cancel_reversal')").get(stockId) as { d: number };
    expect(Math.round(net.d * 1000)).toBe(-600);
    const day = new Date(); const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const report = (await app.inject({ url: `/api/reports/profit?from=${key}&to=${key}`, headers: auth(token) })).json().report;
    const dish = report.tables.find((t: { title: string }) => t.title === "By dish").rows[0];
    expect(dish).toMatchObject({ name: "Paneer", qty: 3, cost: 60_000 });
  });

  it("changes a note without touching stock and respects the print setting", async () => {
    const { itemId } = await sentItem(2);
    const quiet = await edit(itemId, { note: "Less spicy", print: false });
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json().order.items[0]).toMatchObject({ qty: 2, note: "Less spicy" });
    expect(editJobs()).toHaveLength(0);
    expect(balance()).toBe(9.6);
    const settings = (await app.inject({ url: "/api/settings", headers: auth(token) })).json().settings;
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { ...settings, kotEditPrint: "always" } });
    expect((await app.inject({ url: "/api/kot-edit-settings", headers: auth(token) })).json()).toEqual({ print: "always" });
    expect((await edit(itemId, { note: "No onion", print: false })).statusCode).toBe(200);
    expect(editJobs()).toHaveLength(1);
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { ...settings, kotEditPrint: "never" } });
    expect((await edit(itemId, { note: null })).statusCode).toBe(200);
    expect(editJobs()).toHaveLength(1);
  });

  it("refuses increases, pending items, no-op edits and missing reasons; replays are idempotent", async () => {
    const { orderId, itemId } = await sentItem(2);
    expect((await edit(itemId, { qty: 3, reason: "More" })).statusCode).toBe(400);
    expect((await edit(itemId, { qty: 1 })).statusCode).toBe(400);
    expect((await edit(itemId, { qty: 2, reason: "Same" })).statusCode).toBe(400);
    const added = await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
    const pending = (added.json().order.items as Array<{ id: string; status: string }>).find((i) => i.status === "pending")!;
    expect((await edit(pending.id, { note: "x" })).statusCode).toBe(409);
    const payload = { clientRef: uuidv7(), qty: 1, reason: "Mistake" };
    const send = () => app.inject({ method: "POST", url: `/api/order-items/${itemId}/edit-sent`, headers: auth(token), payload });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM kot_edits").get()).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE status = 'cancelled'").get()).toEqual({ n: 1 });
    expect((await app.inject({ method: "POST", url: `/api/order-items/${itemId}/edit-sent`, headers: auth(token), payload: { ...payload, reason: "Other" } })).statusCode).toBe(409);
  });

  it("lets a waiter change the note but not cut the quantity", async () => {
    const waiter = await createUser(app, token, { name: "Ravi", pin: "2222", role: "waiter" });
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const { itemId } = await sentItem(2);
    expect((await edit(itemId, { note: "Extra gravy", print: false }, waiter.token)).statusCode).toBe(200);
    const cut = await edit(itemId, { qty: 1, reason: "Wrong" }, waiter.token);
    expect(cut.statusCode).toBe(403);
    expect(cut.json().permission).toBe("orders.cancel_sent");
    expect((await edit(itemId, { qty: 1, reason: "Wrong" }, cashier.token)).statusCode).toBe(200);
  });
});
