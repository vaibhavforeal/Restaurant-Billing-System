import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, commercialApp, createUser, enableIntegration, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { setModuleEnabled } from "./modules.js";

describe("sales and collection reports", () => {
  let app: FastifyInstance, token: string, adminId: string, productId: string, categoryId: string;
  const post = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: "POST", url, payload: payload as object, headers: auth(token) });
    if (response.statusCode >= 400) throw new Error(response.body); return response.json();
  };
  const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
  async function issue(day: number, discountPaise = 0, qty = 1) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId, qty }] });
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
    ({ app } = freshAppWithFakeSink()); let admin; ({ token, user: admin } = await setupAdmin(app)); adminId = admin.id;
    const { category } = await post("/api/categories", { name: "Meals" });
    const { product } = await post("/api/products", { name: "Meal", categoryId: category.id, pricePaise: 10001, gstRate: 5, kotStationId: null }); productId = product.id; categoryId = category.id;
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
  it("totals the charges on each day and the range", async () => {
    app.db.prepare("UPDATE settings SET packaging_charge_paise = 2000 WHERE id = 1").run();
    const first = await issue(27), second = await issue(29);
    const result = await report();
    expect(first.charges).toHaveLength(1); expect(second.charges).toHaveLength(1);
    expect(result.daily.map((d: any) => d.sales.chargesPaise)).toEqual([2000, 0, 2000]);
    expect(result.sales.chargesPaise).toBe(4000);
    const existing = (await app.inject({ url: "/api/reports/day-end?date=2026-09-27", headers: auth(token) })).json().report;
    expect(existing.sales.chargesPaise).toBe(2000);
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
  describe("offers report", () => {
    const offersReport = (query = "from=2026-09-27&to=2026-09-29", headers: Record<string, string> = auth(token)) => app.inject({ url: `/api/reports/offers?${query}`, headers });
    let mealOff: string, flatOff: string;
    beforeEach(async () => {
      enableIntegration(app, "offers");
      // 10% off each Meal (₹100.01 → ₹10.00 a unit), and ₹50 off a bill of ₹250 or more once the item offers are taken.
      mealOff = (await post("/api/offers", { name: "Meal 10%", kind: "item_off", percentBp: 1000, categoryIds: [categoryId] })).offer.id;
      flatOff = (await post("/api/offers", { name: "Flat 50", kind: "bill_off", amountPaise: 5000, minBillPaise: 25000 })).offer.id;
    });
    it("counts the bills each offer was on and sums its discount, biggest first, leaving out void bills and other dates", async () => {
      const one = await issue(27), three = await issue(28, 0, 3), voided = await issue(29, 0, 3), outside = await issue(30);
      expect(one.offerDiscountPaise).toBe(1000);
      expect(three.offerDiscountPaise).toBe(3000 + 5000);
      app.db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(voided.id);
      expect(outside.offerDiscountPaise).toBe(1000);
      const res = await offersReport();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ rows: [
        { offerId: flatOff, name: "Flat 50", bills: 1, discountPaise: 5000 },
        { offerId: mealOff, name: "Meal 10%", bills: 2, discountPaise: 1000 + 3000 },
      ] });
    });
    it("shows an offer's current name, and has no rows for a range without offers", async () => {
      await issue(27);
      const renamed = await app.inject({ method: "PUT", url: `/api/offers/${mealOff}`, headers: auth(token), payload: { name: "Lunch 10%", kind: "item_off", percentBp: 1000, categoryIds: [categoryId] } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await offersReport()).json().rows).toEqual([{ offerId: mealOff, name: "Lunch 10%", bills: 1, discountPaise: 1000 }]);
      expect((await offersReport("from=2026-09-28&to=2026-09-29")).json()).toEqual({ rows: [] });
    });
    it("takes the same date range as the sales report", async () => {
      await issue(27);
      expect((await offersReport("from=2026-09-27&to=2026-09-27")).json().rows).toHaveLength(1);
      expect((await app.inject({ url: "/api/reports/offers", headers: auth(token) })).statusCode).toBe(200);
      for (const query of ["from=2026-02-30&to=2026-03-01", "from=2026-09-30&to=2026-09-27", "from=2025-01-01&to=2026-12-31", "from=bad&to=2026-09-27"]) {
        expect((await offersReport(query)).statusCode, query).toBe(400);
      }
    });
    it("allows cashiers, denies waiter, kitchen and anonymous access, and follows the Offers and Reports modules", async () => {
      for (const [role, pin, status] of [["cashier", "2345", 200], ["waiter", "3456", 403], ["kitchen", "4567", 403]] as const) {
        const user = await createUser(app, token, { name: role, role, pin });
        expect((await offersReport(undefined, auth(user.token))).statusCode, role).toBe(status);
      }
      expect((await app.inject("/api/reports/offers")).statusCode).toBe(401);
      for (const id of ["offers", "reports"] as const) {
        setModuleEnabled(app, id, false, adminId);
        const res = await offersReport();
        expect(res.statusCode, id).toBe(409);
        expect(res.json().code).toBe("module_off");
        setModuleEnabled(app, id, true, adminId);
      }
      expect((await offersReport()).statusCode).toBe(200);
    });
    it("refuses the report when the licence leaves Offers out", async () => {
      const f = await commercialApp("basic", { offers: false });
      try {
        const res = await f.app.inject({ url: "/api/reports/offers", headers: f.headers });
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().code).toBe("module_off");
      } finally { await f.app.close(); f.app.db.close(); }
    });
  });
});
