import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type OperationalReport, appendStockMove } from "@forkflow/domain";
import { freshAppWithFakeSink, setupAdmin, createUser, auth, enableIntegration } from "./test-helpers.js";

describe("operational reports", () => {
  let app: FastifyInstance, token: string, categoryId: string, productId: string;
  const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
  const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function post(url: string, payload: object, as = token) {
    const res = await request("POST", url, payload, as); expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function report(kind: string, from = "2026-09-27", to = "2026-09-29"): Promise<OperationalReport> {
    const res = await request("GET", `/api/reports/operations/${kind}?from=${from}&to=${to}`);
    expect(res.statusCode, res.body).toBe(200); return res.json().report;
  }
  async function order(items = [{ productId, qty: 1 }]) {
    const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
    const result = await post(`/api/orders/${order.id}/items`, { items: items.map((i) => ({ ...i, clientRef: uuidv7() })) });
    return result.order;
  }
  async function issue(orderId: string, discountPaise = 0) {
    const input = { discountPaise, ...(discountPaise ? { discountNote: "Offer" } : {}) };
    const { preview } = await post(`/api/orders/${orderId}/bill-preview`, input);
    const { bill } = await post(`/api/orders/${orderId}/bill`, { ...input, previewKey: preview.previewKey, clientRef: uuidv7() });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(27), bill.id);
    return bill;
  }
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app)); enableIntegration(app, "kds");
    categoryId = (await post("/api/categories", { name: "Meals" })).category.id;
    productId = (await post("/api/products", { name: "Meal", categoryId, pricePaise: 10001, gstRate: 5, kotStationId: null })).product.id;
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); app.db.close(); });

  it.each([false, true])("reconciles every paise for mixed-tax bills, saved categories and void bills kept on their issue date (inclusive=%s)", async (inclusive) => {
    app.db.prepare("UPDATE settings SET tax_inclusive = ?").run(Number(inclusive));
    const otherCategory = (await post("/api/categories", { name: "Drinks" })).category.id;
    const other = (await post("/api/products", { name: "Juice", categoryId: otherCategory, pricePaise: 5353, gstRate: 12, kotStationId: null })).product.id;
    const o = await order([{ productId, qty: 2 }, { productId, qty: 1 }, { productId: other, qty: 3 }]);
    const bill = await issue(o.id, 999);
    const free = await issue((await order()).id, 10001);
    const voided = await issue((await order()).id);
    app.db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(voided.id);
    const saved = app.db.prepare("SELECT * FROM bills").all();
    await request("PATCH", `/api/categories/${categoryId}`, { name: "Renamed" });
    await request("PATCH", `/api/products/${productId}`, { name: "Changed", categoryId: otherCategory, pricePaise: 99999 });
    const result = await report("items");
    // A void bill stays in its issue date's sales; only a credit note (none here) subtracts it, on its own date.
    for (const table of result.tables) {
      expect(table.totals).toMatchObject({ bills: 3, qty: 8, subtotal: bill.subtotalPaise + free.subtotalPaise + voided.subtotalPaise, discount: bill.discountPaise + free.discountPaise,
        gst: bill.cgstPaise + bill.sgstPaise + voided.cgstPaise + voided.sgstPaise, rounding: bill.roundingPaise + voided.roundingPaise, total: bill.totalPaise + voided.totalPaise });
      expect(table.rows.reduce((sum, r) => sum + Number(r.total), 0)).toBe(bill.totalPaise + voided.totalPaise);
    }
    expect(result.tables[1]!.rows.map((r) => r.category)).toContain("Meals");
    expect(result.tables[0]!.rows.some((r) => r.name === "Meal")).toBe(true);
    expect(app.db.prepare("SELECT * FROM bills").all()).toEqual(saved);
    expect(() => app.db.exec("UPDATE bill_report_lines SET total_paise = 0")).toThrow(/immutable/);
  });

  it("attributes split receipts to the settling cashier and payment date, independently of bill issuer", async () => {
    const cashier = await createUser(app, token, { name: "Counter 2", role: "cashier", pin: "2345" });
    const bill = await issue((await order()).id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(26), bill.id);
    await post(`/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 5000 }, { mode: "upi", amountPaise: bill.totalPaise - 5000 }] }, cashier.token);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at(28), bill.id);
    const table = (await report("cashiers")).tables[0]!;
    expect(table.rows).toEqual([{ cashier: "Counter 2", bills: 1, cash: 5000, upi: bill.totalPaise - 5000, card: 0, refunds: 0, total: bill.totalPaise }]);
    expect((await report("items")).tables[0]!.rows).toHaveLength(0);
    // Money received stays on its payment date even if the bill is later void; refunds subtract on their own date.
    app.db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(bill.id);
    expect((await report("cashiers")).tables[0]!.rows).toEqual(table.rows);
  });

  it("shows all local hours and respects inclusive dates and midnight boundaries", async () => {
    const first = await issue((await order()).id), last = await issue((await order()).id), outside = await issue((await order()).id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(27, 0), first.id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(29, 23), last.id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(30, 0), outside.id);
    const table = (await report("hourly")).tables[0]!;
    expect(table.rows).toHaveLength(24); expect(table.rows[0]!.bills).toBe(1); expect(table.rows[23]!.bills).toBe(1);
    expect(table.totals!.bills).toBe(2); expect(table.totals!.total).toBe(first.totalPaise + last.totalPaise);
  });

  it("measures completed KOTs, pending tickets and full cancellations without diluting averages", async () => {
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    await request("PATCH", `/api/products/${productId}`, { kotStationId: station.id });
    const tickets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await order();
      await post(`/api/orders/${o.id}/send`, { clientRef: uuidv7(), itemIds: o.items.map((item: { id: string }) => item.id) });
      const kot = app.db.prepare("SELECT id FROM kots WHERE order_id = ?").get(o.id) as { id: string };
      tickets.push(kot.id); app.db.prepare("UPDATE kots SET created_at = ? WHERE id = ?").run(at(27), kot.id);
      if (i === 2) await post(`/api/order-items/${o.items[0].id}/cancel`, { reason: "Guest changed mind" });
    }
    await post(`/api/kots/${tickets[0]}/done`, {});
    app.db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(at(27) + 12 * 60000, tickets[0]!);
    const data = await report("kots");
    expect(data.tables[0]!.rows[0]).toMatchObject({ tickets: 3, completed: 1, pending: 1, cancelled: 1, average: 12, longest: 12 });
    expect(data.tables[1]!.rows.find((r) => r.status === "Pending")!.minutes).toBeNull();
  });

  it("records exact cancellation times and staff; whole-order cancellation audits remaining pending items", async () => {
    const o = await order([{ productId, qty: 2 }, { productId, qty: 1 }]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(at(28));
    await post(`/api/order-items/${o.items[0].id}/cancel`, { reason: "Wrong dish" });
    await post(`/api/orders/${o.id}/cancel`, { reason: "Guest left" });
    clock.mockRestore();
    const result = await report("cancellations");
    expect(result.tables[0]!.rows).toHaveLength(2);
    expect(result.tables[0]!.totals).toMatchObject({ qty: 3, value: 30003 });
    expect(result.tables[0]!.rows.every((r) => r.time === at(28) && r.staff === "Asha")).toBe(true);
    expect(result.tables[1]!.rows[0]!.reason).toBe("Guest left");
    expect((await report("cancellations", "2026-09-27", "2026-09-27")).tables[0]!.rows).toHaveLength(0);
    app.db.prepare("UPDATE order_items SET cancelled_at = NULL WHERE id = ?").run(o.items[0].id);
    expect((await report("cancellations")).notes.join(" ")).toContain("1 historical cancelled item");
  });

  it("reconciles stock opening, receipts, consumption, reversals, wastage, counts and later movements", async () => {
    const { item } = await post("/api/stock-items", { clientRef: uuidv7(), name: "Rice", unit: "kg", openingQty: 0 });
    const moves = [
      { day: 26, delta: 10, reason: "adjustment" }, { day: 27, delta: 5, reason: "purchase" },
      { day: 27, delta: -2.125, reason: "sale" }, { day: 28, delta: 0.125, reason: "cancel_reversal" },
      { day: 29, delta: -1, reason: "wastage" }, { day: 29, delta: -0.5, reason: "adjustment" }, { day: 30, delta: 9, reason: "purchase" },
    ] as const;
    for (const move of moves) {
      const clock = vi.spyOn(Date, "now").mockReturnValue(at(move.day));
      const actor = app.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
      app.db.transaction(() => appendStockMove(app.db, { stockItemId: item.id, delta: move.delta, reason: move.reason, note: "Counted", actorId: actor.id }))(); clock.mockRestore();
    }
    const before = app.db.prepare("SELECT * FROM stock_moves").all();
    const data = await report("stock");
    expect(data.tables[0]!.rows[0]).toEqual({ item: "Rice", unit: "kg", opening: 10, received: 5, consumed: 2.125, restored: 0.125, wastage: 1, adjustment: -0.5, closing: 11.5 });
    expect(data.tables[1]!.rows).toHaveLength(5); expect(app.db.prepare("SELECT * FROM stock_moves").all()).toEqual(before);
  });

  it("validates every report date range and role and returns usable empty results", async () => {
    const waiter = await createUser(app, token, { name: "Waiter", role: "waiter", pin: "2345" });
    const kitchen = await createUser(app, token, { name: "Cook", role: "kitchen", pin: "3456" });
    const cashier = await createUser(app, token, { name: "Cashier", role: "cashier", pin: "4567" });
    for (const kind of ["items", "cashiers", "hourly", "kots", "cancellations", "stock", "credit-notes"]) {
      for (const user of [waiter, kitchen]) expect((await request("GET", `/api/reports/operations/${kind}`, undefined, user.token)).statusCode).toBe(403);
      expect((await request("GET", `/api/reports/operations/${kind}`, undefined, cashier.token)).statusCode).toBe(200);
      expect((await app.inject(`/api/reports/operations/${kind}`)).statusCode).toBe(401);
      for (const dates of ["from=2026-02-30&to=2026-03-01", "from=2026-09-29&to=2026-09-27", "from=2020-01-01&to=2026-01-01"]) {
        expect((await request("GET", `/api/reports/operations/${kind}?${dates}`)).statusCode).toBe(400);
      }
      expect((await report(kind)).today).toBe(localDateKey(Date.now()));
    }
  });
});
