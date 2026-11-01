import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CUSTOM_REPORT_SOURCES, uuidv7, type CustomReportConfigInput, type OperationalReport } from "@masalapos/domain";
import { freshApp, setupAdmin, createUser, auth } from "./test-helpers.js";

describe("custom reports", () => {
  let app: FastifyInstance, token: string, adminId: string, cashier: string, productId: string;
  const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).getTime();
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function post(url: string, payload: object) {
    const res = await request("POST", url, payload); expect(res.statusCode, res.body).toBeLessThan(400); return res.json();
  }
  async function bill(day: number, hour: number, qty: number, discountPaise = 0) {
    const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
    await post(`/api/orders/${order.id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    const input = { discountPaise, ...(discountPaise ? { discountNote: "Offer" } : {}) };
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, input);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...input, previewKey: preview.previewKey, clientRef: uuidv7() });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at(day, hour), bill.id);
    return bill as { id: string; billNo: number; totalPaise: number };
  }
  async function run(config: CustomReportConfigInput, range = { from: "2026-09-27", to: "2026-09-29" }, as = token) {
    return request("POST", "/api/custom-reports/run", { config, ...range }, as);
  }
  async function table(config: CustomReportConfigInput, range?: { from: string; to: string }) {
    const res = await run(config, range); expect(res.statusCode, res.body).toBe(200);
    return (res.json().report as OperationalReport).tables[0]!;
  }
  beforeEach(async () => {
    app = freshApp(); ({ token, user: { id: adminId } } = await setupAdmin(app));
    ({ token: cashier } = await createUser(app, token, { name: "Ravi", pin: "5678", role: "cashier" }));
    const { category } = await post("/api/categories", { name: "Mains" });
    ({ product: { id: productId } } = await post("/api/products", { categoryId: category.id, name: "Paneer", pricePaise: 20000, gstRate: 5, kotStationId: null }));
  });

  it("lists bills with chosen columns, renamed headings and a total", async () => {
    const first = await bill(27, 13, 1), second = await bill(28, 20, 2);
    const t = await table({ source: "bills", columns: [{ field: "billNo" }, { field: "date" }, { field: "total", label: "Bill value" }], sort: { field: "billNo", dir: "asc" } });
    expect(t.columns.map((c) => [c.key, c.label, c.format])).toEqual([["billNo", "Bill no.", undefined], ["date", "Date", undefined], ["total", "Bill value", "money"]]);
    expect(t.rows.map((r) => [r.billNo, r.date])).toEqual([[first.billNo, "2026-09-27"], [second.billNo, "2026-09-28"]]);
    expect(t.totals).toEqual({ billNo: "Total", total: Number(t.rows[0]!.total) + Number(t.rows[1]!.total) });
  });

  it("groups by a dimension, summing measures, and keeps the date range per source", async () => {
    await bill(27, 13, 1); await bill(27, 14, 1); await bill(28, 20, 2); await bill(1, 12, 5);
    const t = await table({ source: "bills", columns: [{ field: "date" }, { field: "bills" }, { field: "subtotal" }, { field: "averageBill" }], groupBy: ["date"] });
    expect(t.rows.map((r) => [r.date, r.bills, r.subtotal])).toEqual([["2026-09-27", 2, 40000], ["2026-09-28", 1, 40000]]);
    expect(t.totals).toEqual({ date: "Total", bills: 3, subtotal: 80000 });
  });

  it("filters rows, and keeps or drops whole groups when a measure is filtered", async () => {
    await bill(27, 13, 1); await bill(28, 20, 3);
    const rows = await table({ source: "bills", columns: [{ field: "billNo" }, { field: "subtotal" }], filters: [{ field: "subtotal", op: "gte", value: 50000 }] });
    expect(rows.rows.map((r) => r.subtotal)).toEqual([60000]);
    const groups = await table({ source: "bills", columns: [{ field: "date" }, { field: "subtotal" }], groupBy: ["date"], filters: [{ field: "subtotal", op: "lt", value: 50000 }] });
    expect(groups.rows.map((r) => r.date)).toEqual(["2026-09-27"]);
    const text = await table({ source: "bills", columns: [{ field: "status" }, { field: "table" }], filters: [{ field: "table", op: "contains", value: "take" }] });
    expect(text.rows).toHaveLength(2);
    expect((await table({ source: "bills", columns: [{ field: "billNo" }], filters: [{ field: "table", op: "contains", value: "%" }] })).rows).toHaveLength(0);
  });

  it("reports item lines, payments and customers from their own sources", async () => {
    const issued = await bill(27, 13, 2);
    await post(`/api/bills/${issued.id}/settle`, { payments: [{ mode: "cash", amountPaise: issued.totalPaise }], clientRef: uuidv7() });
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at(27, 14), issued.id);
    const items = await table({ source: "bill_items", columns: [{ field: "item" }, { field: "category" }, { field: "qty" }, { field: "total" }], groupBy: ["item", "category"] });
    expect(items.rows).toEqual([{ item: "Paneer", category: "Mains", qty: 2, total: 40000 }]);
    const payments = await table({ source: "payments", columns: [{ field: "mode" }, { field: "amount" }], groupBy: ["mode"] });
    expect(payments.rows).toEqual([{ mode: "cash", amount: 40000 }]);
    const customers = await table({ source: "customers", columns: [{ field: "name" }, { field: "visits" }, { field: "pointsBalance" }] });
    expect(customers.rows).toEqual([]);
  });

  it("leaves Zomato settlements out of payments, as Collections does", async () => {
    const issued = await bill(27, 13, 1);
    app.db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, created_at) VALUES (?, ?, 'zomato', ?, ?)").run(uuidv7(), issued.id, issued.totalPaise, at(27, 14));
    const other = await bill(27, 15, 1);
    await post(`/api/bills/${other.id}/settle`, { payments: [{ mode: "upi", amountPaise: other.totalPaise }], clientRef: uuidv7() });
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at(27, 16), other.id);
    const t = await table({ source: "payments", columns: [{ field: "mode" }, { field: "amount" }], groupBy: ["mode"] });
    expect(t.rows).toEqual([{ mode: "upi", amount: other.totalPaise }]);
  });

  it("splits points into earned, redeemed and reversed/adjusted so they reconcile with the balance", async () => {
    const customer = uuidv7();
    app.db.prepare("INSERT INTO customers (id, name, phone, created_at, created_by) VALUES (?, 'Meera', '9876543210', ?, ?)").run(customer, at(1), adminId);
    const ledger = app.db.prepare("INSERT INTO loyalty_ledger (id, customer_id, kind, points, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [kind, points] of [["earn", 100], ["redeem", -30], ["reverse", -40], ["adjust", 5]] as const) ledger.run(uuidv7(), customer, kind, points, at(28), adminId);
    const t = await table({ source: "customers", columns: [{ field: "name" }, { field: "pointsEarned" }, { field: "pointsRedeemed" }, { field: "pointsOther" }, { field: "pointsBalance" }] });
    expect(t.rows).toEqual([{ name: "Meera", pointsEarned: 100, pointsRedeemed: 30, pointsOther: -35, pointsBalance: 35 }]);
  });

  it("breaks ties in a chosen sort with the default order, so the same rows come back every run", async () => {
    const bills = [await bill(27, 13, 1), await bill(27, 14, 1), await bill(27, 15, 1)];
    const t = await table({ source: "bills", columns: [{ field: "status" }, { field: "billNo" }], sort: { field: "status", dir: "asc" } });
    expect(t.rows.map((r) => r.billNo)).toEqual(bills.map((b) => b.billNo).reverse());
    const grouped = await table({ source: "bills", columns: [{ field: "hour" }, { field: "bills" }], groupBy: ["hour"], sort: { field: "bills", dir: "desc" } });
    expect(grouped.rows.map((r) => r.hour)).toEqual(["13:00", "14:00", "15:00"]);
  });

  it("rejects definitions that do not match the catalogue", async () => {
    const bad = async (config: CustomReportConfigInput, message: RegExp) => {
      const res = await run(config); expect(res.statusCode, res.body).toBe(400); expect(res.json().error ?? res.body).toMatch(message);
    };
    await bad({ source: "bills", columns: [{ field: "id; DROP TABLE bills" }] }, /not a column/);
    await bad({ source: "bills", columns: [{ field: "total" }, { field: "total" }] }, /twice/);
    await bad({ source: "bills", columns: [{ field: "date" }, { field: "total" }], groupBy: ["time"] }, /Cannot group by/);
    await bad({ source: "bills", columns: [{ field: "date" }, { field: "total" }], groupBy: ["status"] }, /must be grouped by/);
    await bad({ source: "bills", columns: [{ field: "total" }], filters: [{ field: "total", op: "contains", value: "1" }] }, /cannot be filtered/);
    await bad({ source: "bills", columns: [{ field: "total" }], filters: [{ field: "total", op: "gt", value: "1" }] }, /needs a number/);
    await bad({ source: "bills", columns: [{ field: "total" }], sort: { field: "date", dir: "asc" } }, /Sort by one of/);
    expect((await run({ source: "bills", columns: [] })).statusCode).toBe(400);
    expect((await run({ source: "kitchen" as never, columns: [{ field: "x" }] })).statusCode).toBe(400);
  });

  it("every catalogue field has SQL that actually runs, in detail and grouped form", async () => {
    await bill(27, 13, 1);
    for (const source of CUSTOM_REPORT_SOURCES) {
      const columns = source.fields.map((f) => ({ field: f.id }));
      expect((await run({ source: source.id, columns })).statusCode, source.id).toBe(200);
      const group = source.fields.find((f) => f.role === "dimension" && f.groupable !== false)!;
      const grouped = source.fields.filter((f) => f.role === "measure").map((f) => ({ field: f.id }));
      const res = await run({ source: source.id, columns: [{ field: group.id }, ...grouped], groupBy: [group.id] });
      expect(res.statusCode, `${source.id}: ${res.body}`).toBe(200);
    }
  });

  it("saves reports for admins only, with unique names, and cashiers can read and run them", async () => {
    const config = { source: "bills", columns: [{ field: "date" }, { field: "total" }], groupBy: ["date"] } satisfies CustomReportConfigInput;
    expect((await request("POST", "/api/custom-reports", { name: "Daily", config }, cashier)).statusCode).toBe(403);
    const created = await request("POST", "/api/custom-reports", { name: "Daily", config }); expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json().report;
    expect((await request("POST", "/api/custom-reports", { name: "daily", config })).statusCode).toBe(409);
    expect((await request("POST", "/api/custom-reports", { name: "Bad", config: { ...config, groupBy: ["status"] } })).statusCode).toBe(400);
    const listed = await request("GET", "/api/custom-reports", undefined, cashier);
    expect(listed.json().reports.map((r: { name: string }) => r.name)).toEqual(["Daily"]);
    expect((await run(listed.json().reports[0].config, undefined, cashier)).statusCode).toBe(200);
    expect((await request("PUT", `/api/custom-reports/${id}`, { name: "Daily totals", config }, cashier)).statusCode).toBe(403);
    const renamed = await request("PUT", `/api/custom-reports/${id}`, { name: "Daily totals", config }); expect(renamed.json().report.name).toBe("Daily totals");
    expect((await request("DELETE", `/api/custom-reports/${id}`, undefined, cashier)).statusCode).toBe(403);
    expect((await request("DELETE", `/api/custom-reports/${id}`)).statusCode).toBe(204);
    expect((await request("DELETE", `/api/custom-reports/${id}`)).statusCode).toBe(404);
  });
});
