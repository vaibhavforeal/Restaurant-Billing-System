import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { defaultLayout, type DashboardData, type WidgetValue } from "@masalapos/domain/dashboard";
import { freshApp, setupAdmin, createUser, auth, enableIntegration } from "./test-helpers.js";

type Options = Partial<{ period: string; compare: string; orderType: string; topN: number }>;
const NO_ACCESS = "You no longer have access to this widget.";

describe("dashboard widget data", () => {
  let app: FastifyInstance, token: string, adminId: string, cashier: string, cashierId: string, productId: string;
  const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();
  const request = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function post(url: string, payload: object) {
    const res = await request("POST", url, payload); expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  /** A parcel bill of `qty` Paneer at 200 rupees each, rewritten to the given local time. */
  async function bill(month: number, day: number, hour: number, qty: number, discountPaise = 0) {
    const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
    await post(`/api/orders/${order.id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    const input = { discountPaise, ...(discountPaise ? { discountNote: "Offer" } : {}) };
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, input);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...input, previewKey: preview.previewKey, clientRef: uuidv7() });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(month, day, hour), bill.id);
    return bill as { id: string; totalPaise: number };
  }
  async function settle(billId: string, mode: "cash" | "upi" | "card", amountPaise: number, month: number, day: number) {
    await post(`/api/bills/${billId}/settle`, { payments: [{ mode, amountPaise }], clientRef: uuidv7() });
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at(month, day, 13), billId);
  }
  const widget = (key: string, name: string, options: Options = {}) => ({ key, widget: name, options: { ...defaultLayout().items[0]!.options, ...options } });
  async function data(widgets: object[], as = token) {
    const res = await request("POST", "/api/dashboard/data", { widgets }, as);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DashboardData;
  }
  const number = (value: WidgetValue) => { if (value.kind !== "number") throw new Error("not a number"); return value.value; };
  const current = (result: DashboardData["results"][string]) => { if (!result.ok) throw new Error(result.error); return result.current; };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 28, 15));
    app = freshApp(); ({ token, user: { id: adminId } } = await setupAdmin(app));
    ({ token: cashier, id: cashierId } = await createUser(app, token, { name: "Ravi", pin: "5678", role: "cashier" }));
    enableIntegration(app, "dynamicReports");
    const { category } = await post("/api/categories", { name: "Mains" });
    ({ product: { id: productId } } = await post("/api/products", { categoryId: category.id, name: "Paneer", pricePaise: 20000, gstRate: 5, kotStationId: null }));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("matches the sales report for the same range", async () => {
    const paid = await bill(8, 28, 12, 2, 1000);
    await settle(paid.id, "cash", paid.totalPaise, 8, 28);
    const upi = await bill(8, 27, 12, 1);
    await settle(upi.id, "upi", upi.totalPaise, 8, 27);
    const voided = await bill(8, 27, 14, 1);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(8, 27, 14), voided.id);
    // The credit note is stamped now (the 28th), so it subtracts there while the bill stays on the 27th.
    await post(`/api/bills/${voided.id}/void`, { clientRef: uuidv7(), reason: "Wrong bill", refunds: [] });

    const range = { from: "2026-09-27", to: "2026-09-28" };
    const sales = (await request("GET", `/api/reports/sales?from=${range.from}&to=${range.to}`)).json().report;
    expect(sales.creditNotePaise).toBeGreaterThan(0);
    const options = { period: "last7", compare: "none" };
    const out = await data([
      widget("a", "netSales", options), widget("b", "billCount", options), widget("c", "discounts", options),
      widget("d", "creditNotes", options), widget("e", "paymentMix", options), widget("f", "gstCollected", options),
    ]);
    // last7 ends today, so it covers the 27th and 28th and earlier days without bills.
    expect(number(current(out.results.a!))).toBe(sales.netTotalPaise);
    expect(number(current(out.results.b!))).toBe(sales.sales.billCount);
    expect(number(current(out.results.c!))).toBe(sales.sales.discountPaise);
    expect(number(current(out.results.d!))).toBe(sales.creditNotePaise);
    expect(number(current(out.results.f!))).toBe(sales.sales.cgstPaise + sales.sales.sgstPaise);
    expect(current(out.results.e!)).toEqual({ kind: "series", format: "money", points: [
      { label: "Cash", value: sales.collections.cashPaise }, { label: "UPI", value: sales.collections.upiPaise },
      { label: "Card", value: sales.collections.cardPaise }, { label: "Zomato receivable", value: sales.zomatoReceivablePaise },
    ] });
    expect(out.results.a).toMatchObject({ ok: true, range: { from: "2026-09-22", to: "2026-09-28" }, compare: null, compareRange: null });
  });

  it("matches order analytics for hourly sales, top items and order-type split, with an order-type filter", async () => {
    await bill(8, 28, 9, 2); await bill(8, 28, 13, 1);
    const analytics = async (type: string) => (await request("GET", `/api/reports/analytics?from=2026-09-28&to=2026-09-28&type=${type}`)).json().report;
    const all = await analytics("all"), dine = await analytics("dine_in");
    const out = await data([
      widget("h", "hourlySales", { compare: "none" }), widget("i", "topItems", { compare: "none", topN: 3 }),
      widget("t", "orderTypeSplit", { compare: "none" }), widget("hd", "hourlySales", { compare: "none", orderType: "dine_in" }),
      widget("c", "topCategories", { compare: "none" }), widget("d", "dailyTrend", { compare: "none" }),
    ]);
    const hourly = current(out.results.h!);
    expect(hourly.kind === "series" && hourly.points).toHaveLength(24);
    expect(hourly.kind === "series" && hourly.points.map((p) => [p.label, p.value])).toEqual(all.hourly.map((h: { hour: number; totalPaise: number }) => [String(h.hour).padStart(2, "0"), h.totalPaise]));
    expect(hourly.kind === "series" && hourly.points[9]!.value).toBeGreaterThan(0);
    expect(current(out.results.i!)).toEqual({ kind: "ranking", rows: all.items.slice(0, 3).map((i: { name: string; totalPaise: number; qty: number }) => ({ label: i.name, value: i.totalPaise, qty: i.qty })) });
    expect(current(out.results.c!)).toEqual({ kind: "ranking", rows: all.categories.slice(0, 5).map((i: { name: string; totalPaise: number; qty: number }) => ({ label: i.name, value: i.totalPaise, qty: i.qty })) });
    const split = current(out.results.t!);
    expect(split.kind === "series" && split.points).toEqual([
      { label: "Dine-in", value: 0 }, { label: "Takeaway", value: all.totals.totalPaise }, { label: "Zomato", value: 0 },
    ]);
    const filtered = current(out.results.hd!);
    expect(filtered.kind === "series" && filtered.points.every((p) => p.value === 0)).toBe(true);
    expect(dine.totals.totalPaise).toBe(0);
    const daily = current(out.results.d!);
    expect(daily).toEqual({ kind: "series", format: "money", points: [{ label: "2026-09-28", value: all.totals.totalPaise }] });
  });

  it("ranks top items by sales, not quantity, and keeps only topN", async () => {
    const { category } = await post("/api/categories", { name: "Drinks" });
    const make = async (name: string, pricePaise: number) =>
      (await post("/api/products", { categoryId: category.id, name, pricePaise, gstRate: 5, kotStationId: null })).product.id as string;
    const tea = await make("Tea", 1000), cola = await make("Cola", 2000), lassi = await make("Lassi", 3000);
    const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
    // Paneer 1 x 20000 is the top seller by value; Tea sells the most units for the least money.
    const lines = [[productId, 1], [tea, 8], [cola, 2], [lassi, 3]] as const;
    await post(`/api/orders/${order.id}/items`, { items: lines.map(([id, qty]) => ({ productId: id, qty, clientRef: uuidv7() })) });
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
    const { bill: issued } = await post(`/api/orders/${order.id}/bill`, { previewKey: preview.previewKey, clientRef: uuidv7() });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(8, 28, 12), issued.id);
    const out = await data([widget("i", "topItems", { compare: "none", topN: 3 })]);
    const ranking = current(out.results.i!);
    if (ranking.kind !== "ranking") throw new Error("not a ranking");
    expect(ranking.rows.map((r) => r.label)).toEqual(["Paneer", "Lassi", "Tea"]);
    expect(ranking.rows.map((r) => r.qty)).toEqual([1, 3, 8]);
  });

  it("compares with the previous period and with last week", async () => {
    const now = await bill(8, 28, 12, 2), before = await bill(8, 27, 12, 1), lastWeek = await bill(8, 21, 12, 3);
    const out = await data([widget("p", "netSales", { period: "today", compare: "previous" }), widget("w", "netSales", { period: "today", compare: "lastWeek" }),
      widget("r", "topItems", { period: "today", compare: "previous" })]);
    expect(out.results.p).toMatchObject({ ok: true, range: { from: "2026-09-28", to: "2026-09-28" }, compareRange: { from: "2026-09-27", to: "2026-09-27" } });
    expect(out.results.w).toMatchObject({ compareRange: { from: "2026-09-21", to: "2026-09-21" } });
    expect(number(current(out.results.p!))).toBe(now.totalPaise);
    const p = out.results.p!, w = out.results.w!;
    expect(p.ok && p.compare && number(p.compare)).toBe(before.totalPaise);
    expect(w.ok && w.compare && number(w.compare)).toBe(lastWeek.totalPaise);
    expect(out.results.r).toMatchObject({ ok: true, compare: null, compareRange: null });
  });

  it("resolves \"today\" at request time", async () => {
    vi.setSystemTime(new Date(2026, 8, 28, 23, 59));
    const first = await data([widget("a", "netSales", { compare: "none" })]);
    vi.setSystemTime(new Date(2026, 8, 29, 0, 1));
    const second = await data([widget("a", "netSales", { compare: "none" })]);
    expect(first.today).toBe("2026-09-28");
    expect(second.today).toBe("2026-09-29");
    expect(first.results.a).toMatchObject({ range: { from: "2026-09-28", to: "2026-09-28" } });
    expect(second.results.a).toMatchObject({ range: { from: "2026-09-29", to: "2026-09-29" } });
    expect(second.generatedAt).toBe(new Date(2026, 8, 29, 0, 1).getTime());
    expect(typeof second.timezone).toBe("string");
  });

  it("averageBill with no bills is 0 and no value is NaN", async () => {
    const all = ["netSales", "billCount", "averageBill", "discounts", "gstCollected", "creditNotes", "outstanding", "cashCollected", "upiCollected", "cardCollected",
      "cancellations", "hourlySales", "dailyTrend", "paymentMix", "orderTypeSplit", "topItems", "topCategories", "openTables", "runningKots", "pendingQr", "lowStock", "unsettledBills"];
    enableIntegration(app, "kds");
    app.db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('inventory', 1, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1").run(Date.now(), adminId);
    const out = await data(all.map((name) => widget(name, name)));
    expect(number(current(out.results.averageBill!))).toBe(0);
    const bad: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "number") { if (!Number.isFinite(value)) bad.push(path); }
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(out, "data");
    expect(bad).toEqual([]);
    expect(Object.values(out.results).every((r) => r.ok)).toBe(true);
  });

  it("counts open tables, running KOTs, pending QR requests, low stock and unsettled bills", async () => {
    enableIntegration(app, "kds");
    app.db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('inventory', 1, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1").run(Date.now(), adminId);
    const tableIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const { table } = await post("/api/tables", { name: `T${i}` });
      await post("/api/orders", { type: "dine_in", tableId: table.id, clientRef: uuidv7() });
      tableIds.push(table.id);
    }
    // A second open order on a table counts that table once.
    await post("/api/orders", { type: "dine_in", tableId: tableIds[0], splitLabel: "B", clientRef: uuidv7() });
    const now = Date.now();
    const orderId = app.db.prepare("SELECT id FROM orders WHERE table_id = ?").pluck().get(tableIds[0]) as string;
    app.db.prepare("INSERT INTO kot_stations (id, name) VALUES ('st', 'Main')").run();
    const kot = app.db.prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by, done_at) VALUES (?, ?, ?, 'st', ?, ?, ?)");
    kot.run("k1", orderId, 1, now, adminId, null); kot.run("k2", orderId, 2, now, adminId, null); kot.run("k3", orderId, 3, now, adminId, now);
    const guest = app.db.prepare(`INSERT INTO guest_requests (id, client_ref, table_id, table_name, receipt_hash, fingerprint, items_json, subtotal_paise, status, created_at, expires_at)
      VALUES (?, ?, ?, 'T1', 'h', 'f', '[]', 0, ?, ?, ?)`);
    guest.run("g1", "g1", tableIds[0], "pending", now, now + 60_000); guest.run("g2", "g2", tableIds[0], "pending", now - 120_000, now - 60_000);
    guest.run("g3", "g3", tableIds[0], "accepted", now, now + 60_000);
    const stock = (name: string, qty: number, threshold: number | null, active = 1) => app.db.prepare(
      "INSERT INTO stock_items (id, name, unit, qty, low_stock_threshold, is_active, client_ref, request_json) VALUES (?, ?, 'kg', ?, ?, ?, ?, '{}')").run(uuidv7(), name, qty, threshold, active, uuidv7());
    for (const name of ["A", "B", "C", "D", "E", "F"]) stock(`Low ${name}`, 1, 2);
    stock("Fine", 10, 2); stock("No level", 0, null); stock("Retired", 0, 5, 0);
    const first = await bill(8, 28, 10, 1), second = await bill(8, 28, 11, 2);
    await settle(second.id, "cash", second.totalPaise, 8, 28);

    const out = await data(["openTables", "runningKots", "pendingQr", "lowStock", "unsettledBills"].map((name) => widget(name, name)));
    const status = (key: string) => { const v = current(out.results[key]!); if (v.kind !== "status") throw new Error("not status"); return v; };
    expect(status("openTables").count).toBe(7);
    expect(status("openTables").detail).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(status("runningKots").count).toBe(2);
    expect(status("pendingQr").count).toBe(1);
    expect(status("lowStock").count).toBe(6);
    expect(status("lowStock").detail).toHaveLength(5);
    expect(status("unsettledBills")).toMatchObject({ count: 1, amountPaise: first.totalPaise });
    expect(out.results.openTables).toMatchObject({ range: null, compare: null, compareRange: null });
  });

  it("answers one widget's failure without failing the rest", async () => {
    app.db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('inventory', 1, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1").run(Date.now(), adminId);
    const grant = await request("PUT", `/api/users/${cashierId}/permissions`, { overrides: { "reports.dashboard": true, "stock.read": false } });
    expect(grant.statusCode).toBe(200);
    const out = await data([widget("low", "lowStock"), widget("net", "netSales")], cashier);
    expect(out.results.low).toEqual({ ok: false, error: NO_ACCESS });
    expect(out.results.net).toMatchObject({ ok: true });
  });

  it("rejects more than 30 widgets with 400", async () => {
    const many = Array.from({ length: 31 }, (_, i) => widget(`k${i}`, "netSales"));
    expect((await request("POST", "/api/dashboard/data", { widgets: many })).statusCode).toBe(400);
    const repeated = await request("POST", "/api/dashboard/data", { widgets: [widget("same", "netSales"), widget("same", "billCount")] });
    expect(repeated.statusCode).toBe(400);
  });

  it("is refused without the permission or while the module is off, and is never cached", async () => {
    expect((await request("POST", "/api/dashboard/data", { widgets: [] }, cashier)).statusCode).toBe(403);
    const ok = await request("POST", "/api/dashboard/data", { widgets: [] });
    expect(ok.headers["cache-control"]).toBe("no-store");
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'dynamicReports'").run();
    expect((await request("POST", "/api/dashboard/data", { widgets: [] })).statusCode).toBe(409);
  });
});
