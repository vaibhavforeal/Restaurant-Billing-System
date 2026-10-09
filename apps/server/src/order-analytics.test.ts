import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@forkflow/domain";
import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

describe("order analytics", () => {
  let app: FastifyInstance, token: string, productId: string, otherId: string, tableId: string;
  const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
  async function post(url: string, payload: object) {
    const res = await app.inject({ method: "POST", url, payload, headers: auth(token) });
    expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function issue(type: "parcel" | "dine_in", items: { productId: string; qty: number; variantId?: string }[] = [{ productId, qty: 1 }], day = 27, hour = 12, discountPaise = 0) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type, ...(type === "dine_in" ? { tableId } : {}) });
    // Order creation predates billing to check analytics use bill date.
    app.db.prepare("UPDATE orders SET opened_at = ? WHERE id = ?").run(at(26), order.id);
    await post(`/api/orders/${order.id}/items`, { items: items.map((item) => ({ ...item, clientRef: uuidv7() })) });
    const options = { discountPaise, ...(discountPaise ? { discountNote: "Offer" } : {}) };
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, options);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(day, hour), bill.id);
    return bill;
  }
  async function report(type = "all", from = "2026-09-27", to = "2026-09-29"): Promise<OrderAnalyticsReport> {
    const res = await app.inject({ url: `/api/reports/analytics?type=${type}&from=${from}&to=${to}`, headers: auth(token) });
    expect(res.statusCode, res.body).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
    return res.json().report;
  }
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const { category } = await post("/api/categories", { name: "Meals" });
    productId = (await post("/api/products", { name: "Meal", categoryId: category.id, pricePaise: 10001, gstRate: 5, kotStationId: null })).product.id;
    otherId = (await post("/api/products", { name: "Juice", categoryId: category.id, pricePaise: 5353, gstRate: 12, kotStationId: null })).product.id;
    tableId = (await post("/api/tables", { name: "T1" })).table.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  it.each(["included", "none"])("counts multi-line orders once and reconciles every paise (gst mode %s)", async (gstMode) => {
    app.db.prepare("UPDATE settings SET gst_mode = ?").run(gstMode);
    const parcel = await issue("parcel", [{ productId, qty: 3 }, { productId, qty: 2 }, { productId: otherId, qty: 1 }], 27, 12, 999);
    const table = await issue("dine_in", [{ productId: otherId, qty: 2 }], 29, 18);
    const before = app.db.prepare("SELECT * FROM bills ORDER BY id").all();
    const result = await report();
    expect(result.totals).toEqual({ orderCount: 2, qty: 8, totalPaise: parcel.totalPaise + table.totalPaise });
    expect(result.comparison).toEqual([{ type: "parcel", orderCount: 1, qty: 6, totalPaise: parcel.totalPaise }, { type: "dine_in", orderCount: 1, qty: 2, totalPaise: table.totalPaise },
      { type: "zomato", orderCount: 0, qty: 0, totalPaise: 0 }]);
    expect(result.items[0]).toMatchObject({ name: "Meal", qty: 5, orderCount: 1, takeawayQty: 5, tableQty: 0 });
    expect(result.items[1]).toMatchObject({ name: "Juice", qty: 3, orderCount: 2, takeawayQty: 1, tableQty: 2 });
    expect(result.items.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(result.totals.totalPaise);
    expect(result.categories[0]).toMatchObject({ name: "Meals", qty: 8, orderCount: 2, totalPaise: result.totals.totalPaise });
    const sales = (await app.inject({ url: "/api/reports/sales?from=2026-09-27&to=2026-09-29", headers: auth(token) })).json().report;
    expect(result.totals.totalPaise).toBe(sales.sales.totalPaise);
    expect(app.db.prepare("SELECT * FROM bills ORDER BY id").all()).toEqual(before);
  });

  it("filters totals, items, categories, days and hours while preserving both comparison rows", async () => {
    const parcel = await issue("parcel", [{ productId, qty: 3 }]);
    const table = await issue("dine_in", [{ productId, qty: 2 }], 29, 18);
    const all = await report();
    for (const [type, bill, qty] of [["parcel", parcel, 3], ["dine_in", table, 2]] as const) {
      const result = await report(type);
      expect(result.orderType).toBe(type); expect(result.comparison).toEqual(all.comparison);
      expect(result.totals).toEqual({ orderCount: 1, qty, totalPaise: bill.totalPaise });
      expect(result.items[0]).toMatchObject({ qty, totalPaise: bill.totalPaise, takeawayQty: type === "parcel" ? 3 : 0, tableQty: type === "dine_in" ? 2 : 0 });
      expect(result.categories[0]!.totalPaise).toBe(bill.totalPaise);
      expect(result.daily.reduce((sum, row) => sum + row.takeawayOrders + row.tableOrders, 0)).toBe(1);
      expect(result.daily.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(bill.totalPaise);
      expect(result.hourly.reduce((sum, row) => sum + row.orderCount, 0)).toBe(1);
      expect(result.hourly.reduce((sum, row) => sum + row.totalPaise, 0)).toBe(bill.totalPaise);
    }
  });

  it("includes unpaid, complimentary and void bills by issue date, excludes open orders and cancelled items", async () => {
    const unpaid = await issue("parcel");
    const free = await issue("parcel", [{ productId, qty: 1 }], 27, 12, 10001);
    await post(`/api/bills/${free.id}/settle`, { clientRef: uuidv7(), payments: [] });
    const voided = await issue("parcel");
    app.db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(voided.id);
    const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
    const { order: updated } = await post(`/api/orders/${order.id}/items`, { items: [{ productId, qty: 7, clientRef: uuidv7() }, { productId, qty: 9, clientRef: uuidv7() }] });
    await post(`/api/order-items/${updated.items[0].id}/cancel`, { reason: "Changed mind" });
    const result = await report();
    // A void bill stays in its issue date's figures; only its credit note (none here) subtracts, on its own date.
    expect(result.totals).toEqual({ orderCount: 3, qty: 3, totalPaise: unpaid.totalPaise + voided.totalPaise });
    expect(result.items[0]!.qty).toBe(3);
  });

  it("preserves billed item names and categories after catalog edits and separates variants", async () => {
    const { variant } = await post(`/api/products/${productId}/variants`, { name: "Half", pricePaise: 6000 });
    await issue("parcel", [{ productId, qty: 2 }, { productId, variantId: variant.id, qty: 3 }]);
    const res = await app.inject({ method: "PATCH", url: `/api/products/${productId}`, headers: auth(token), payload: { name: "Renamed", pricePaise: 99999 } });
    expect(res.statusCode).toBe(200);
    const result = await report();
    expect(result.items).toHaveLength(2);
    expect(result.items.find((row) => row.variantId === variant.id)).toMatchObject({ qty: 3, category: "Meals" });
    expect(result.items.find((row) => row.variantId === null)).toMatchObject({ name: "Meal", qty: 2 });
  });

  it("uses inclusive local bill dates and supplies zero days and all 24 hours", async () => {
    await issue("parcel", [{ productId, qty: 1 }], 27, 0);
    await issue("parcel", [{ productId, qty: 1 }], 29, 23);
    await issue("parcel", [{ productId, qty: 1 }], 30, 0);
    const result = await report();
    expect(result.daily.map((row) => row.date)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29"]);
    expect(result.daily[1]).toEqual({ date: "2026-09-28", takeawayOrders: 0, tableOrders: 0, totalPaise: 0 });
    expect(result.totals.orderCount).toBe(2); expect(result.hourly).toHaveLength(24);
    expect(result.hourly[0]!.orderCount).toBe(1); expect(result.hourly[23]!.orderCount).toBe(1);
  });

  it("validates dates and order types, applies report permissions, and returns usable empty data", async () => {
    const waiter = await createUser(app, token, { name: "Waiter", pin: "2345", role: "waiter" });
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3456", role: "cashier" });
    expect((await app.inject("/api/reports/analytics")).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/reports/analytics", headers: auth(waiter.token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/reports/analytics", headers: auth(cashier.token) })).statusCode).toBe(200);
    for (const query of ["type=unknown", "from=2026-02-30&to=2026-03-01", "from=2026-09-29&to=2026-09-27", "from=2020-01-01&to=2026-01-01"]) {
      expect((await app.inject({ url: `/api/reports/analytics?${query}`, headers: auth(token) })).statusCode).toBe(400);
    }
    const result = await report();
    expect(result.totals).toEqual({ orderCount: 0, totalPaise: 0, qty: 0 });
    expect(result.comparison).toHaveLength(3); expect(result.items).toEqual([]); expect(result.categories).toEqual([]);
    expect(result.daily).toHaveLength(3); expect(result.hourly).toHaveLength(24);
  });
});
