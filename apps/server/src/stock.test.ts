import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type StockItem, type Bill } from "@forkflow/domain";
import { freshAppWithFakeSink, setupAdmin, auth, createUser } from "./test-helpers.js";

describe("inventory", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Meal", categoryId: c.json().category.id, pricePaise: 10000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function stock(qty = 5, name = "Rice", threshold: number | null = 1): Promise<StockItem> {
    const res = await request("POST", "/api/stock-items", { clientRef: uuidv7(), name, unit: "kg", openingQty: qty, lowStockThreshold: threshold });
    expect(res.statusCode).toBe(201); return res.json().item;
  }
  const balance = (id: string) => (app.db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(id) as { qty: number }).qty;
  async function latest(id: string): Promise<StockItem> { return (await request("GET", "/api/stock-items")).json().items.find((s: StockItem) => s.id === id); }
  async function link(id: string | null, qty = 1) {
    const current = (await request("GET", `/api/products/${productId}/stock-links`)).json();
    const res = await request("PUT", `/api/products/${productId}/stock-links`, { expectedVersion: current.version, stockItemId: id, qtyPerSale: qty });
    expect(res.statusCode).toBe(200); return res.json();
  }
  async function order(qty = 1, kitchen = false) {
    if (kitchen) {
      const s = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
      app.db.prepare("UPDATE products SET kot_station_id = ? WHERE id = ?").run(s.id, productId);
    }
    const o = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order;
    const added = await request("POST", `/api/orders/${o.id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    expect(added.statusCode).toBe(200); return added.json().order as { id: string; items: Array<{ id: string; status: string }> };
  }
  async function issue(orderId: string) {
    const p = await request("POST", `/api/orders/${orderId}/bill-preview`, {}); expect(p.statusCode).toBe(200);
    const payload = { clientRef: uuidv7(), previewKey: p.json().preview.previewKey };
    const result = await request("POST", `/api/orders/${orderId}/bill`, payload); expect(result.statusCode).toBe(201);
    return { bill: result.json().bill as Bill, payload };
  }

  it("creates a stock item and opening movement once, with conflicting retry protection", async () => {
    const body = { clientRef: uuidv7(), name: "Rice", unit: "kg", openingQty: 2.125, lowStockThreshold: 1 };
    const first = await request("POST", "/api/stock-items", body); const again = await request("POST", "/api/stock-items", body);
    expect(first.statusCode).toBe(201); expect(again.statusCode).toBe(200); expect(again.json().item).toEqual(first.json().item);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get()).toEqual({ n: 1 });
    expect((await request("POST", "/api/stock-items", { ...body, openingQty: 4 })).statusCode).toBe(409);
  });
  it("records purchases, waste, physical counts and refuses stale counts or changed retries", async () => {
    let item = await stock(2);
    const purchase = { clientRef: uuidv7(), expectedVersion: item.version, reason: "purchase", quantity: 0.125, note: "Delivery" };
    const first = await request("POST", `/api/stock-items/${item.id}/movements`, purchase);
    expect(first.statusCode).toBe(201); expect(balance(item.id)).toBe(2.125);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, purchase)).statusCode).toBe(200);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { ...purchase, quantity: 0.25 })).statusCode).toBe(409);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { clientRef: uuidv7(), expectedVersion: item.version, reason: "adjustment", quantity: 1, note: "Old count" })).statusCode).toBe(409);
    item = await latest(item.id);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { clientRef: uuidv7(), expectedVersion: item.version, reason: "wastage", quantity: 0.125, note: "Spill" })).statusCode).toBe(201);
    item = await latest(item.id);
    expect((await request("POST", `/api/stock-items/${item.id}/movements`, { clientRef: uuidv7(), expectedVersion: item.version, reason: "adjustment", quantity: 1.5, note: "Physical count" })).statusCode).toBe(201);
    expect(balance(item.id)).toBe(1.5);
    const history = (await request("GET", `/api/stock-items/${item.id}/movements`)).json().movements;
    expect(history.map((m: { delta: number }) => m.delta)).toEqual([-0.5, -0.125, 0.125, 2]);
    expect(history[0]).toMatchObject({ balanceAfter: 1.5, createdByName: "Asha", note: "Physical count" });
  });
  it("deducts kitchen items at send, allows negative stock, warns, and never deducts again at billing/settle", async () => {
    const s = await stock(0.2); await link(s.id, 0.125);
    const o = await order(3, true); expect(balance(s.id)).toBe(0.2);
    const sent = await request("POST", `/api/orders/${o.id}/send`); expect(sent.statusCode).toBe(200);
    expect(balance(s.id)).toBe(-0.175);
    expect(sent.json().order.stockWarnings).toEqual([expect.objectContaining({ id: s.id, qty: -0.175 })]);
    expect((await request("POST", `/api/orders/${o.id}/send`)).statusCode).toBe(409);
    const { bill, payload } = await issue(o.id);
    expect((await request("POST", `/api/orders/${o.id}/bill`, payload)).statusCode).toBe(200);
    expect((await request("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] })).statusCode).toBe(200);
    expect(balance(s.id)).toBe(-0.175);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 1 });
  });
  it("deducts stationless items only at bill issue and replays do not deduct twice", async () => {
    const s = await stock(); await link(s.id, 0.1); const o = await order(3);
    expect(balance(s.id)).toBe(5);
    const preview = await request("POST", `/api/orders/${o.id}/bill-preview`, {}); expect(preview.statusCode).toBe(200); expect(balance(s.id)).toBe(5);
    const { payload } = await issue(o.id); expect(balance(s.id)).toBe(4.7);
    expect((await request("POST", `/api/orders/${o.id}/bill`, payload)).statusCode).toBe(200); expect(balance(s.id)).toBe(4.7);
  });
  it("restores the original sale after product remapping and archiving the old stock", async () => {
    const original = await stock(5, "Original"); const replacement = await stock(8, "Replacement"); await link(original.id, 0.25);
    const o = await order(2, true); await request("POST", `/api/orders/${o.id}/send`); expect(balance(original.id)).toBe(4.5);
    await link(replacement.id, 2);
    const current = await latest(original.id);
    expect((await request("PATCH", `/api/stock-items/${original.id}`, { expectedVersion: current.version, isActive: false })).statusCode).toBe(200);
    const result = await request("POST", `/api/order-items/${o.items[0]!.id}/cancel`, { reason: "Customer cancelled" }); expect(result.statusCode).toBe(200);
    expect(balance(original.id)).toBe(5); expect(balance(replacement.id)).toBe(8);
    expect((await request("POST", `/api/order-items/${o.items[0]!.id}/cancel`, { reason: "Retry" })).statusCode).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'cancel_reversal'").get()).toEqual({ n: 1 });
  });
  it("does not deduct/reverse pending cancellations or untracked products", async () => {
    const s = await stock(); await link(s.id); const o = await order();
    expect((await request("POST", `/api/order-items/${o.items[0]!.id}/cancel`, {})).statusCode).toBe(200); expect(balance(s.id)).toBe(5);
    await link(null); await issue((await order()).id);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get()).toEqual({ n: 1 });
  });
  it("deducts and reverses every saved link, while the simple editor preserves multi-link products", async () => {
    const a = await stock(1, "Ingredient A"); const b = await stock(1, "Ingredient B");
    await link(a.id, 0.125);
    app.db.prepare("INSERT INTO product_stock_links (id,product_id,stock_item_id,qty_per_sale) VALUES (?,?,?,?)").run(uuidv7(), productId, b.id, 0.25);
    const before = (await request("GET", `/api/products/${productId}/stock-links`)).json();
    expect((await request("PUT", `/api/products/${productId}/stock-links`, { expectedVersion: before.version, stockItemId: null })).statusCode).toBe(409);
    const o = await order(2, true); expect((await request("POST", `/api/orders/${o.id}/send`)).statusCode).toBe(200);
    expect(balance(a.id)).toBe(0.75); expect(balance(b.id)).toBe(0.5);
    expect((await request("POST", `/api/order-items/${o.items[0]!.id}/cancel`, { reason: "Cancel whole item" })).statusCode).toBe(200);
    expect(balance(a.id)).toBe(1); expect(balance(b.id)).toBe(1);
  });
  it("rolls back stock and KOT state without events when part of the transaction fails", async () => {
    const s = await stock(); await link(s.id); const o = await order(1, true);
    app.db.exec("CREATE TRIGGER fail_kot BEFORE INSERT ON kots BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(app, "broadcast");
    expect((await request("POST", `/api/orders/${o.id}/send`)).statusCode).toBe(500);
    expect(balance(s.id)).toBe(5); expect(app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 0 });
    expect((await request("GET", `/api/orders/${o.id}`)).json().order.items[0].status).toBe("pending");
    expect(broadcast).not.toHaveBeenCalled();
  });
  it("rolls back bill number, taxes, stock and order status if billing stock write fails", async () => {
    const s = await stock(); await link(s.id); const o = await order();
    const p = await request("POST", `/api/orders/${o.id}/bill-preview`, {});
    app.db.exec("CREATE TRIGGER fail_sale BEFORE INSERT ON stock_moves WHEN NEW.reason = 'sale' BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(app, "broadcast");
    expect((await request("POST", `/api/orders/${o.id}/bill`, { clientRef: uuidv7(), previewKey: p.json().preview.previewKey })).statusCode).toBe(500);
    expect(balance(s.id)).toBe(5); expect(app.db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get()).toEqual({ value: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 }); expect(broadcast).not.toHaveBeenCalled();
    expect((await request("GET", `/api/orders/${o.id}`)).json().order.status).toBe("open");
  });
  it("rolls back a cancellation if its reversal cannot be recorded", async () => {
    const s = await stock(); await link(s.id); const o = await order(1, true); await request("POST", `/api/orders/${o.id}/send`);
    app.db.exec("CREATE TRIGGER fail_reversal BEFORE INSERT ON stock_moves WHEN NEW.reason = 'cancel_reversal' BEGIN SELECT RAISE(ABORT, 'test'); END");
    expect((await request("POST", `/api/order-items/${o.items[0]!.id}/cancel`, { reason: "Cancel" })).statusCode).toBe(500);
    expect(balance(s.id)).toBe(4); expect((await request("GET", `/api/orders/${o.id}`)).json().order.items[0].status).toBe("sent");
  });
  it("guards links and archived stock, while supporting reactivation and keeping old history", async () => {
    const s = await stock(); await link(s.id);
    expect((await request("PATCH", `/api/stock-items/${s.id}`, { expectedVersion: s.version, isActive: false })).statusCode).toBe(409);
    expect((await request("PUT", `/api/products/${productId}/stock-links`, { expectedVersion: 0, stockItemId: null })).statusCode).toBe(409);
    await link(null);
    expect((await request("PATCH", `/api/stock-items/${s.id}`, { expectedVersion: s.version, isActive: false })).statusCode).toBe(200);
    const archived = await latest(s.id);
    expect((await request("POST", `/api/stock-items/${s.id}/movements`, { clientRef: uuidv7(), expectedVersion: archived.version, reason: "purchase", quantity: 1, note: "Delivery" })).statusCode).toBe(409);
    expect((await request("PATCH", `/api/stock-items/${s.id}`, { expectedVersion: archived.version, isActive: true })).statusCode).toBe(200);
    expect((await request("GET", `/api/stock-items/${s.id}/movements`)).json().movements).toHaveLength(1);
  });
  it("enforces permissions, immutable units and low-stock updates without broadcasting full balances", async () => {
    const s = await stock(0, "Rice", null);
    const cashier = await createUser(app, token, { name: "Cashier", role: "cashier", pin: "2222" });
    const waiter = await createUser(app, token, { name: "Waiter", role: "waiter", pin: "3333" });
    expect((await request("GET", "/api/stock-items", undefined, cashier.token)).statusCode).toBe(200);
    expect((await request("GET", "/api/stock-items", undefined, waiter.token)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/stock-items" })).statusCode).toBe(401);
    expect((await request("PATCH", `/api/stock-items/${s.id}`, { expectedVersion: s.version, name: "Changed" }, cashier.token)).statusCode).toBe(403);
    expect((await request("PATCH", `/api/stock-items/${s.id}`, { expectedVersion: s.version, unit: "g" })).statusCode).toBe(400);
    const broadcast = vi.spyOn(app, "broadcast"); await link(s.id); const o = await order(1, true); await request("POST", `/api/orders/${o.id}/send`);
    expect(broadcast).toHaveBeenCalledWith("stock.low", { stockItemIds: [s.id] });
    const warning = (await request("GET", `/api/orders/${o.id}`, undefined, waiter.token)).json().order.stockWarnings;
    expect(warning[0]).toMatchObject({ name: "Rice", qty: -1 });
    const current = await latest(s.id);
    await request("POST", `/api/stock-items/${s.id}/movements`, { clientRef: uuidv7(), expectedVersion: current.version, reason: "purchase", quantity: 3, note: "Restocked" });
    expect((await request("GET", `/api/orders/${o.id}`)).json().order.stockWarnings).toEqual([]);
  });
});
