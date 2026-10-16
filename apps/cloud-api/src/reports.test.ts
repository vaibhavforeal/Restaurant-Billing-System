import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { openDb, MIGRATIONS, migrate } from "@forkflow/domain";
import { registerOperationalReports } from "../../server/src/operational-reports.js";
import { registerCosting } from "../../server/src/costing.js";
import { registerOrderAnalytics } from "../../server/src/order-analytics.js";
import { registerSalesReports } from "../../server/src/sales-reports.js";
import { operationalReport, salesReport } from "./reports.js";
import { testPostgres } from "./testing/postgres.js";

type Row = Record<string, any>;
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
const now = at(12, 18), range = { from: "2026-10-12", to: "2026-10-12" };
const line = (bill: string, item: string, name: string, qty: number, taxable: number) => ({ bill_id: bill, order_item_id: item, product_id: "product", variant_id: null, name, category_id: "category", category_name: "Drinks", qty, subtotal_paise: taxable, discount_paise: 0, taxable_paise: taxable, cgst_paise: taxable / 40, sgst_paise: taxable / 40, rounding_paise: 0, total_paise: taxable * 1.05 });
const fixtures: Record<string, Row[]> = {
  users: ["Issuer", "Cashier", "Approver"].map((name, index) => ({ id: `u${index}`, name, pin_hash: "unused", role: "admin", is_active: 1, created_at: at(1) })),
  categories: [{ id: "category", name: "Drinks" }],
  products: [{ id: "product", category_id: "category", name: "Tea", price_paise: 10000, gst_rate: 5, created_at: at(1) }],
  kot_stations: [{ id: "kitchen", name: "Main kitchen" }],
  dining_tables: [{ id: "table", name: "T1" }],
  orders: ["one", "old", "two", "none", "cancelled"].map((id, i) => ({ id, client_ref: id, type: i === 1 ? "dine_in" : "parcel", table_id: i === 1 ? "table" : null, status: id === "cancelled" ? "cancelled" : "billed", opened_by: "u0", opened_at: at(11), closed_at: at(12), cancelled_by: id === "cancelled" ? "u1" : null, cancel_reason: id === "cancelled" ? "Guest left" : null })),
  kots: [{ id: "k1", order_id: "one", kot_no: 1, station_id: "kitchen", created_at: at(12, 10), created_by: "u0", accepted_at: at(12, 10) + 3 * 60000, done_at: at(12, 10) + 12 * 60000 }, { id: "k2", order_id: "two", kot_no: 2, station_id: "kitchen", created_at: at(12, 11), created_by: "u0", accepted_at: at(12, 11) + 5 * 60000, done_at: null }, { id: "k3", order_id: "cancelled", kot_no: 3, station_id: "kitchen", created_at: at(12, 12), created_by: "u0", done_at: at(12, 12) + 4 * 60000 }],
  order_items: [["i1", "one", "k1", 1.5], ["iOld", "old", null, 1], ["i2", "two", "k2", 1], ["iNone", "none", null, 1], ["i3", "cancelled", "k3", 1]].map(([id, order_id, kot_id, qty]) => ({ id, order_id, kot_id, product_id: "product", name_snapshot: "Tea", price_paise_snapshot: 10000, gst_rate_snapshot: 5, qty, status: id === "i3" ? "cancelled" : "sent", cancelled_at: id === "i3" ? at(12, 13) : null, cancelled_by: id === "i3" ? "u1" : null, cancel_reason: id === "i3" ? "Wrong dish" : null })),
  bills: [["b1", "one", 10000, 12], ["bOld", "old", 8000, 11], ["b2", "two", 2000, 12], ["bNone", "none", 4000, 12]].map(([id, order_id, value, day], index) => ({ id, order_id, bill_no: index + 1, subtotal_paise: value, discount_paise: 0, cgst_paise: Number(value) / 40, sgst_paise: Number(value) / 40, rounding_paise: 0, total_paise: Number(value) * 1.05, status: "paid", created_at: at(Number(day), 11), created_by: "u0" })),
  bill_report_lines: [line("b1", "i1", "Tea|spice", 1.5, 10000), line("bOld", "iOld", "Tea", 1, 8000), line("b2", "i2", "Unknown cost", 1, 2000), line("bNone", "iNone", "No recipe", 1, 4000)],
  bill_settlements: [{ bill_id: "b1", client_ref: "settle1", request_json: "{}", created_by: "u1", created_at: at(12, 15) }, { bill_id: "bOld", client_ref: "settle2", request_json: "{}", created_by: "u1", created_at: at(12, 15) }],
  payments: [{ id: "p1", bill_id: "b1", mode: "cash", amount_paise: 5000, created_at: at(12, 15) }, { id: "p2", bill_id: "b1", mode: "upi", amount_paise: 5500, created_at: at(12, 15) }, { id: "p3", bill_id: "bOld", mode: "card", amount_paise: 8400, created_at: at(12, 15) }, { id: "p4", bill_id: "b2", mode: "cash", amount_paise: 2100, created_at: at(12, 15) }],
  credit_notes: [{ id: "credit", cn_no: 1, bill_id: "b1", kind: "refund", reason: "Returned", taxable_paise: 2000, cgst_paise: 50, sgst_paise: 50, rounding_paise: 0, total_paise: 2100, requested_by: "u1", approved_by: "u2", created_at: at(12, 14), client_ref: "credit", request_json: "{}" }, { id: "oldCredit", cn_no: 2, bill_id: "bOld", kind: "refund", reason: "Older sale", taxable_paise: 800, cgst_paise: 20, sgst_paise: 20, rounding_paise: 0, total_paise: 840, requested_by: "u1", approved_by: "u2", created_at: at(12, 14), client_ref: "oldCredit", request_json: "{}" }],
  credit_note_lines: [{ credit_note_id: "credit", order_item_id: "i1", name: "Tea|spice", category_id: "category", category_name: "Drinks", gst_rate: 5, qty: 0.5, taxable_paise: 2000, cgst_paise: 50, sgst_paise: 50, rounding_paise: 0, total_paise: 2100 }, { credit_note_id: "oldCredit", order_item_id: "iOld", name: "Tea", category_id: "category", category_name: "Drinks", gst_rate: 5, qty: 0.1, taxable_paise: 800, cgst_paise: 20, sgst_paise: 20, rounding_paise: 0, total_paise: 840 }],
  refund_payments: [{ id: "refund", credit_note_id: "credit", mode: "cash", amount_paise: 2100, created_at: at(12, 16) }],
  stock_items: [{ id: "milk", name: "Milk", unit: "L", qty: 3.4 }],
  stock_moves: [{ id: "m1", stock_item_id: "milk", order_item_id: "i1", delta: -0.3, reason: "sale", cost_paise: -3000, created_at: at(11) }, { id: "m2", stock_item_id: "milk", order_item_id: "i2", delta: -0.1, reason: "sale", cost_paise: null, created_at: at(12) }, { id: "m3", stock_item_id: "milk", order_item_id: "i3", delta: -0.1, reason: "sale", cost_paise: -1000, created_at: at(12) }, { id: "m4", stock_item_id: "milk", order_item_id: "i3", reversal_of: "m3", delta: 0.1, reason: "cancel_reversal", cost_paise: 1000, created_at: at(12) }, { id: "m5", stock_item_id: "milk", delta: -0.2, reason: "wastage", cost_paise: -200, created_at: at(12), created_by: "u1", note: "Spilt" }, { id: "m6", stock_item_id: "milk", delta: 1, reason: "purchase", cost_paise: 1000, created_at: at(13) }],
};

function comparable(tables: any[]) {
  return tables.map(table => {
    const moneyKeys = new Set(table.columns.filter((column: any) => column.format === "money").map((column: any) => column.key));
    const row = (value: Row) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, moneyKeys.has(key) && item !== null ? String(item) : item]));
    return { title: table.title, columns: table.columns, rows: table.rows.map(row), ...(table.totals ? { totals: row(table.totals) } : {}) };
  });
}

describe("cloud report parity with recorded outlet facts (real PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof testPostgres>>, pool: Pool, client: PoolClient;
  const db = openDb(":memory:"), outletId = randomUUID(), app = Fastify();
  beforeAll(async () => {
    database = await testPostgres(); pool = new Pool({ connectionString: database.url }); client = await pool.connect();
    await client.query('CREATE TABLE projections(outlet_id uuid,entity_table text,row_data jsonb)');
    migrate(db, MIGRATIONS);
    for (const [table, rows] of Object.entries(fixtures)) for (const row of rows) db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    for (const table of Object.keys(fixtures)) {
      const actual = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of actual) await client.query('INSERT INTO projections VALUES($1,$2,$3)', [outletId, table === "users" ? "staff_roster" : table, row]);
    }
    await client.query('INSERT INTO projections VALUES($1,$2,$3)', [outletId, "outlet_meta", { id: 1, timezone: localZone }]);
    app.decorate("db", db); app.decorate("requirePermission", () => async () => {}); app.decorate("requireFeature", () => async () => {});
    registerOperationalReports(app); registerCosting(app); registerOrderAnalytics(app); registerSalesReports(app); await app.ready();
  }, 120000);
  afterAll(async () => { await app.close(); db.close(); client?.release(); await pool?.end(); await database?.stop(); });
  async function outlet(facts: Record<string, Row[]>) {
    const id = randomUUID();
    for (const [table, rows] of Object.entries(facts)) for (const row of rows) await client.query('INSERT INTO projections VALUES($1,$2,$3)', [id, table, row]);
    return id;
  }

  it.each(["items", "cashiers", "hourly", "credit-notes", "kots", "cancellations", "stock", "profit"])("matches local %s table rows, monetary totals, nulls and schema", async kind => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const path = kind === "profit" ? "/api/reports/profit" : `/api/reports/operations/${kind}`;
      const local = await app.inject(`${path}?from=${range.from}&to=${range.to}`); expect(local.statusCode, local.body).toBe(200);
      const cloud = await operationalReport(client, outletId, kind, range, now);
      expect(comparable(cloud.tables)).toEqual(comparable(local.json().report.tables));
    } finally { clock.mockRestore(); }
  });
  it("nets taxes by credit issue date and excludes aggregator receivables from cash collections", async () => {
    const report = await salesReport(client, outletId, range);
    expect(report.totals).toMatchObject({ taxablePaise: "13200", cgstPaise: "330", sgstPaise: "330", grandTotalPaise: "16800", netSalesPaise: "13860", paidPaise: "18900", creditNotePaise: "2940" });
  });
  it("matches local sales and day-end reconciliation facts", async () => {
    const local = (await app.inject(`/api/reports/sales?from=${range.from}&to=${range.to}`)).json().report;
    const report = await salesReport(client, outletId, range), dayEnd = await operationalReport(client, outletId, "day-end", range, now);
    expect(report.totals).toMatchObject({ grandTotalPaise: String(local.sales.totalPaise), outstandingPaise: String(local.sales.outstandingPaise), paidPaise: String(local.collections.totalPaise), refundPaise: String(local.collections.refundPaise), collectedBillCount: local.collections.billCount, creditNotePaise: String(local.creditNotePaise), netSalesPaise: String(local.netTotalPaise), zomatoReceivablePaise: String(local.zomatoReceivablePaise) });
    expect(dayEnd.tables[0]!.rows).toEqual([report.totals]);
  });
  it("preserves local analytics bill and credit attribution", async () => {
    const local = (await app.inject(`/api/reports/analytics?from=${range.from}&to=${range.to}`)).json().report;
    const cloud = await operationalReport(client, outletId, "analytics", range, now);
    expect(cloud.tables.find(table => table.title === "Service type")?.rows).toEqual(local.comparison.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
    expect(cloud.tables.find(table => table.title === "Daily order analytics")?.rows).toEqual(local.daily.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
    expect(cloud.tables.find(table => table.title === "Hourly order analytics")?.rows).toEqual(local.hourly.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
    expect(cloud.tables.find(table => table.title === "Item order analytics")?.rows).toEqual(local.items.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
    expect(cloud.tables.find(table => table.title === "Category order analytics")?.rows).toEqual(local.categories.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
  });
  it("applies the local service filter without changing the service comparison", async () => {
    const local = (await app.inject(`/api/reports/analytics?from=${range.from}&to=${range.to}&type=dine_in`)).json().report;
    const cloud = await operationalReport(client, outletId, "analytics", { ...range, type: "dine_in" }, now);
    expect(cloud.tables.find(table => table.title === "Order analytics totals")?.rows).toEqual([{ ...local.totals, totalPaise: String(local.totals.totalPaise) }]);
    expect(cloud.tables.find(table => table.title === "Daily order analytics")?.rows).toEqual(local.daily.map((row: Row) => ({ ...row, totalPaise: String(row.totalPaise) })));
  });
  it("keeps monetary sums above Number.MAX_SAFE_INTEGER exact", async () => {
    const huge = "9007199254740993", created_at = Date.parse("2026-10-12T12:00Z");
    const id = await outlet({ bills: [{ id: "large", created_at, subtotal_paise: huge, total_paise: huge }], bill_report_lines: [{ bill_id: "large", order_item_id: "item", name: "Large", category_name: "Recorded", qty: 0.5, taxable_paise: huge, total_paise: huge }], stock_moves: [{ id: "cost", order_item_id: "item", reason: "sale", cost_paise: "-9007199254740900", created_at: 0 }] });
    expect((await salesReport(client, id, range)).totals.grandTotalPaise).toBe(huge);
    const profit = await operationalReport(client, id, "profit", range, now);
    expect(profit.tables[0]!.rows.find(row => row.metric === "Gross profit")).toMatchObject({ amount: "93" });
    expect(profit.tables[2]!.rows[0]).toMatchObject({ qty: 0.5, revenue: huge, cost: "9007199254740900", profit: "93" });
  });
  it("excludes Zomato receipts from collections and preserves issued supply details", async () => {
    const created_at = Date.parse("2026-10-12T12:00Z");
    const id = await outlet({ orders: [{ id: "z", type: "zomato", zomato_order_id: "Z123" }], bills: [{ id: "b", order_id: "z", bill_no: 1, created_at, total_paise: 500 }], payments: [{ id: "p", bill_id: "b", created_at, mode: "zomato", amount_paise: 500 }] });
    const report = await salesReport(client, id, range); expect(report.totals.paidPaise).toBe("0"); expect(report.paymentMethods).toEqual([]);
    expect((await operationalReport(client, id, "cashiers", range, now)).tables[0]!.rows).toEqual([]);
    expect((await operationalReport(client, id, "items", range, now)).tables[2]!.rows).toEqual([{ billNo: 1, zomatoOrderId: "Z123", date: created_at, value: "500" }]);
  });
  it("excludes reversed consumption and opening balances from recorded profit costs", async () => {
    const created_at = Date.parse("2026-10-12T12:00Z"), id = await outlet({ bills: [{ id: "b", created_at }], bill_report_lines: [{ bill_id: "b", order_item_id: "i", name: "Dish", category_name: "Food", qty: 1, taxable_paise: 1000 }], stock_moves: [
      { id: "sale", order_item_id: "i", reason: "sale", cost_paise: -300, created_at: 0 }, { id: "reversal", reversal_of: "sale", reason: "cancel_reversal", cost_paise: 300, created_at: 0 },
      { id: "opening", reason: "adjustment", cost_paise: -500, client_ref: null, created_at }, { id: "count", reason: "adjustment", cost_paise: -200, client_ref: "manual", created_at }, { id: "unknown", reason: "wastage", cost_paise: null, created_at },
    ] });
    const report = await operationalReport(client, id, "profit", range, now);
    expect(report.tables[2]!.rows[0]).toMatchObject({ status: "No recipe", cost: null, profit: null });
    expect(report.tables[0]!.rows.find(row => row.metric === "Count adjustments (net)")).toMatchObject({ amount: "200" });
    expect(report.notes.join(" ")).toContain("1 wastage movements have no recorded cost");
  });
  it("includes both occurrences of a repeated daylight-saving hour", async () => {
    const id = await outlet({ outlet_meta: [{ id: 1, timezone: "America/New_York" }], bills: ["2026-11-01T05:30Z", "2026-11-01T06:30Z", "2026-11-02T04:30Z", "2026-11-02T05:00Z"].map((time, index) => ({ id: String(index), created_at: Date.parse(time), total_paise: 100 })) });
    const report = await operationalReport(client, id, "hourly", { from: "2026-11-01", to: "2026-11-01" }, now);
    expect(report.tables[0]!.rows[1]).toMatchObject({ bills: 2, total: "200" });
    expect(report.tables[0]!.rows[23]).toMatchObject({ bills: 1, total: "100" });
    expect(report.tables[0]!.totals).toMatchObject({ bills: 3, total: "300" });
  });
  it("preserves a fractional cancelled menu value without rounding it into a billed fact", async () => {
    const id = await outlet({ orders: [{ id: "order" }], order_items: [{ id: "item", order_id: "order", status: "cancelled", cancelled_at: Date.parse("2026-10-12T12:00Z"), name_snapshot: "Portion", qty: 1.5, price_paise_snapshot: 101 }] });
    const report = await operationalReport(client, id, "cancellations", range, now);
    expect(report.tables[0]!.rows[0]).toMatchObject({ qty: 1.5, value: "151.5" });
    expect(report.tables[0]!.totals).toMatchObject({ qty: 1.5, value: "151.5" });
  });
  it.each([{ to: "not-a-date" }, { to: "2026-02-30" }, { from: "2026-10-13", to: "2026-10-12" }, { from: "2025-10-12", to: "2026-10-13" }])("rejects an invalid report range as a client error: %j", async query => {
    await expect(salesReport(client, outletId, query)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("filters local calendar dates across UTC midnight and supplies all local hour buckets", async () => {
    const other = randomUUID();
    for (const [table, row] of [["outlet_meta", { id: 1, timezone: "Asia/Kolkata" }], ["bills", { id: "night", total_paise: 1050, subtotal_paise: 1000, discount_paise: 0, cgst_paise: 25, sgst_paise: 25, created_at: Date.parse("2026-10-11T19:00:00Z") }], ["credit_notes", { id: "night-credit", total_paise: 100, taxable_paise: 100, cgst_paise: 0, sgst_paise: 0, created_at: Date.parse("2026-10-11T19:30:00Z") }]] as const) await client.query('INSERT INTO projections VALUES($1,$2,$3)', [other, table, row]);
    const sales = await salesReport(client, other, range); expect(sales.totals.netSalesPaise).toBe("950"); expect(sales.timezone).toBe("Asia/Kolkata");
    const hourly = await operationalReport(client, other, "hourly", range, now); expect(hourly.tables[0]!.rows).toHaveLength(24); expect(hourly.tables[0]!.rows[0]).toMatchObject({ bills: 1, total: "1050" }); expect(hourly.tables[0]!.rows[1]).toMatchObject({ bills: 0, total: "-100" });
  });
});
