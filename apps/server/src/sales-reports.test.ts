import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@forkflow/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("sales and collection reports", () => {
  let app: FastifyInstance, token: string, productId: string;
  const post = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: "POST", url, payload: payload as object, headers: auth(token) });
    if (response.statusCode >= 400) throw new Error(response.body); return response.json();
  };
  const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
  async function issue(day: number, discountPaise = 0) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId, qty: 1 }] });
    const options = { discountPaise, ...(discountPaise ? { discountNote: "Test discount" } : {}) };
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, options);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(day), bill.id);
    return bill;
  }
  async function pay(bill: { id: string; totalPaise: number }, day: number, split = false) {
    const payments = bill.totalPaise === 0 ? [] : split ? [{ mode: "cash", amountPaise: 5000 }, { mode: "upi", amountPaise: bill.totalPaise - 5000 }] : [{ mode: "card", amountPaise: bill.totalPaise }];
    await post(`/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments });
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at(day), bill.id);
  }
  const report = async (from = "2026-09-27", to = "2026-09-29") => (await app.inject({ url: `/api/reports/sales?from=${from}&to=${to}`, headers: auth(token) })).json().report;
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const { category } = await post("/api/categories", { name: "Meals" });
    const { product } = await post("/api/products", { name: "Meal", categoryId: category.id, pricePaise: 10001, gstRate: 5, kotStationId: null }); productId = product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });
  it("matches existing day-end values, includes empty days, and never rewrites bills", async () => {
    const first = await issue(27, 333); await issue(29); await pay(first, 29);
    const before = app.db.prepare("SELECT * FROM bills ORDER BY id").all();
    const result = await report();
    expect(result.daily.map((d: any) => d.date)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29"]);
    for (const day of result.daily) {
      const existing = (await app.inject({ url: `/api/reports/day-end?date=${day.date}`, headers: auth(token) })).json().report;
      expect(day.sales).toEqual(existing.sales);
      expect(day.collections.totalPaise).toBe(existing.netPayments.reduce((sum: number, p: any) => sum + p.amountPaise, 0));
      expect(day.netTotalPaise).toBe(existing.net.totalPaise);
    }
    expect(result.daily[1].sales.totalPaise).toBe(0);
    expect(result.sales.totalPaise).toBe(result.daily.reduce((sum: number, d: any) => sum + d.sales.totalPaise, 0));
    expect(app.db.prepare("SELECT * FROM bills ORDER BY id").all()).toEqual(before);
  });
  it("separates older-bill receipts from issued sales, counts split payments once, keeps void bills on their dates", async () => {
    const older = await issue(26); await pay(older, 27, true);
    const unpaid = await issue(27); const voided = await issue(28); await pay(voided, 28);
    // A void bill stays in its issue date's sales and its payment in that date's collections; only credit notes
    // and refunds (none here) subtract, on their own date.
    app.db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(voided.id);
    const result = await report();
    expect(result.sales).toMatchObject({ billCount: 2, totalPaise: unpaid.totalPaise + voided.totalPaise, outstandingPaise: unpaid.totalPaise });
    expect(result).toMatchObject({ creditNotePaise: 0, netTotalPaise: unpaid.totalPaise + voided.totalPaise });
    expect(result.collections).toEqual({ billCount: 2, cashPaise: 5000, upiPaise: older.totalPaise - 5000, cardPaise: voided.totalPaise, refundPaise: 0, totalPaise: older.totalPaise + voided.totalPaise });
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ? AND mode = 'upi'").run(at(28), older.id);
    const acrossDays = await report(); expect(acrossDays.collections.billCount).toBe(2);
    expect(acrossDays.daily.reduce((sum: number, d: any) => sum + d.collections.billCount, 0)).toBe(3);
  });
  it("uses inclusive local dates and validates calendar dates and bounded ranges", async () => {
    const start = await issue(27), outside = await issue(30);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(27, 0), start.id);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(30, 0), outside.id);
    expect((await report()).sales.billCount).toBe(1);
    for (const query of ["from=2026-02-30&to=2026-03-01", "from=2026-09-30&to=2026-09-27", "from=2025-01-01&to=2026-12-31", "from=bad&to=2026-09-27"]) {
      expect((await app.inject({ url: `/api/reports/sales?${query}`, headers: auth(token) })).statusCode).toBe(400);
    }
    expect((await report("2024-01-01", "2024-12-31")).daily).toHaveLength(366);
    expect((await app.inject({ url: "/api/reports/sales", headers: auth(token) })).json().report.daily).toHaveLength(7);
  });
  it("retains zero-value issued bills without inventing payment rows", async () => {
    const free = await issue(27, 10001); await pay(free, 27);
    const result = await report();
    expect(result.sales).toMatchObject({ billCount: 1, totalPaise: 0 });
    expect(result.collections).toEqual({ billCount: 0, cashPaise: 0, upiPaise: 0, cardPaise: 0, refundPaise: 0, totalPaise: 0 });
  });
  it("allows cashiers and denies waiter, kitchen and anonymous financial access", async () => {
    for (const [role, pin, status] of [["cashier", "2345", 200], ["waiter", "3456", 403], ["kitchen", "4567", 403]] as const) {
      const user = await createUser(app, token, { name: role, role, pin });
      expect((await app.inject({ url: "/api/reports/sales", headers: auth(user.token) })).statusCode).toBe(status);
    }
    expect((await app.inject("/api/reports/sales")).statusCode).toBe(401);
  });
});
