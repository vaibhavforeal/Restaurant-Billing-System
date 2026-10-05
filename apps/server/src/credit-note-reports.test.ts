import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type Bill, type OperationalReport, type PayMode } from "@forkflow/domain";
import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

/** Reports with credit notes: issued bills stay on their issue date; voids and refunds subtract on their own date. */
describe("reports net of credit notes", () => {
  let app: FastifyInstance;
  let admin: { token: string; user: { id: string; name: string } };
  let cashier: { id: string; token: string };
  let productId: string;
  const now = new Date();
  const today = localDateKey(now.getTime());
  const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime();
  const yesterday = localDateKey(yesterdayNoon);

  beforeEach(async () => {
    app = freshApp();
    admin = await setupAdmin(app);
    cashier = await createUser(app, admin.token, { name: "Cara", pin: "5678", role: "cashier" });
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(admin.token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(admin.token), payload: { name: "Thali", categoryId: category.json().category.id, pricePaise: 3333, gstRate: 5, kotStationId: null } });
    expect(product.statusCode).toBe(201);
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  /** 3 thalis (3 x 3333 -> 10500: taxable 9999, CGST 250, SGST 250, round-off 1), settled by `settle` in full by `settler`. */
  async function bill(settle: PayMode | false = "cash", settler = admin.token): Promise<Bill> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    expect((await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(admin.token), payload: { items: [{ productId, qty: 3, clientRef: uuidv7() }] } })).statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(admin.token), payload: {} });
    const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(admin.token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    expect(issued.statusCode, issued.body).toBe(201);
    const b = issued.json().bill as Bill;
    if (!settle) return b;
    const paid = await app.inject({ method: "POST", url: `/api/bills/${b.id}/settle`, headers: auth(settler), payload: { clientRef: uuidv7(), payments: [{ mode: settle, amountPaise: b.totalPaise }] } });
    expect(paid.statusCode, paid.body).toBe(200);
    return paid.json().bill as Bill;
  }
  /** Move a bill and its payments to yesterday noon, as if issued and paid then. */
  function issuedYesterday(billId: string) {
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(yesterdayNoon, billId);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(yesterdayNoon, billId);
  }
  const orderItemOf = (billId: string) => (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(billId) as { id: string }).id;
  async function voidBill(billId: string, refunds: Array<{ mode: PayMode; amountPaise: number }>) {
    const res = await app.inject({ method: "POST", url: `/api/bills/${billId}/void`, headers: auth(admin.token), payload: { clientRef: uuidv7(), reason: "Wrong bill", refunds } });
    expect(res.statusCode, res.body).toBe(201);
  }
  /** A cashier-requested refund of `qty` thalis, approved by the admin's PIN. */
  async function refund(billId: string, qty: number, refunds: Array<{ mode: PayMode; amountPaise: number }>, token = cashier.token) {
    const res = await app.inject({ method: "POST", url: `/api/bills/${billId}/refund`, headers: auth(token),
      payload: { clientRef: uuidv7(), reason: "Cold food", lines: [{ orderItemId: orderItemOf(billId), qty }], refunds, approverPin: "1234" } });
    expect(res.statusCode, res.body).toBe(201);
  }
  const get = async (url: string) => {
    const res = await app.inject({ url, headers: auth(admin.token) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().report;
  };
  const dayEnd = (date: string) => get(`/api/reports/day-end?date=${date}`);
  const sales = (from: string, to: string) => get(`/api/reports/sales?from=${from}&to=${to}`);
  const operations = (kind: string, from = today, to = today): Promise<OperationalReport> => get(`/api/reports/operations/${kind}?from=${from}&to=${to}`);
  const analytics = (from = today, to = today): Promise<OrderAnalyticsReport> => get(`/api/reports/analytics?from=${from}&to=${to}`);

  it("voiding yesterday's bill today leaves yesterday unchanged and shows the credit note and net figures today", async () => {
    const b = await bill("cash");
    issuedYesterday(b.id);
    const before = {
      dayEnd: await dayEnd(yesterday),
      sales: (await sales(yesterday, yesterday)).daily,
      items: (await operations("items", yesterday, yesterday)).tables,
      cashiers: (await operations("cashiers", yesterday, yesterday)).tables,
      hourly: (await operations("hourly", yesterday, yesterday)).tables,
      analytics: await analytics(yesterday, yesterday),
    };
    expect(before.dayEnd.sales).toMatchObject({ billCount: 1, totalPaise: 10500 });

    await voidBill(b.id, [{ mode: "cash", amountPaise: 10500 }]);

    // Yesterday, as filed, does not move.
    const after = await dayEnd(yesterday);
    expect(after).toEqual(before.dayEnd);
    expect(after.sales).toMatchObject({ billCount: 1, totalPaise: 10500, cgstPaise: 250, sgstPaise: 250 });
    expect(after.taxes).toEqual([{ gstRate: 5, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250 }]);
    expect(after.payments).toEqual([{ mode: "cash", amountPaise: 10500 }]);
    expect(after.netPayments).toEqual([{ mode: "cash", amountPaise: 10500 }]);
    expect(after.creditNotes).toEqual({ count: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0, taxes: [] });
    expect(after.net).toEqual({ totalPaise: 10500, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250 });
    expect((await sales(yesterday, yesterday)).daily).toEqual(before.sales);
    expect((await operations("items", yesterday, yesterday)).tables).toEqual(before.items);
    expect((await operations("cashiers", yesterday, yesterday)).tables).toEqual(before.cashiers);
    expect((await operations("hourly", yesterday, yesterday)).tables).toEqual(before.hourly);
    const analyticsAfter = await analytics(yesterday, yesterday);
    expect({ ...analyticsAfter, generatedAt: 0 }).toEqual({ ...before.analytics, generatedAt: 0 });

    // Today carries the credit note, the cash paid back and the net figures.
    const todayReport = await dayEnd(today);
    expect(todayReport.sales).toMatchObject({ billCount: 0, totalPaise: 0 });
    expect(todayReport.creditNotes).toEqual({ count: 1, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500,
      taxes: [{ gstRate: 5, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250 }] });
    expect(todayReport.refunds).toEqual([{ mode: "cash", amountPaise: 10500 }]);
    expect(todayReport.payments).toEqual([]);
    expect(todayReport.netPayments).toEqual([{ mode: "cash", amountPaise: -10500 }]);
    expect(todayReport.net).toEqual({ totalPaise: -10500, taxablePaise: -9999, cgstPaise: -250, sgstPaise: -250 });

    const range = await sales(yesterday, today);
    expect(range.daily).toEqual([
      { date: yesterday, sales: expect.objectContaining({ billCount: 1, totalPaise: 10500 }), creditNotePaise: 0, netTotalPaise: 10500,
        collections: { billCount: 1, cashPaise: 10500, upiPaise: 0, cardPaise: 0, refundPaise: 0, totalPaise: 10500 } },
      { date: today, sales: expect.objectContaining({ billCount: 0, totalPaise: 0 }), creditNotePaise: 10500, netTotalPaise: -10500,
        collections: { billCount: 0, cashPaise: -10500, upiPaise: 0, cardPaise: 0, refundPaise: 10500, totalPaise: -10500 } },
    ]);
    expect(range).toMatchObject({ creditNotePaise: 10500, netTotalPaise: 0, collections: { billCount: 1, cashPaise: 0, refundPaise: 10500, totalPaise: 0 } });

    const items = (await operations("items")).tables[0]!;
    expect(items.rows).toEqual([expect.objectContaining({ name: "Thali", qty: 0, total: 0, creditQty: 3, credit: 10500, netQty: -3, netTotal: -10500 })]);
    const hourly = (await operations("hourly")).tables[0]!;
    expect(hourly.totals).toMatchObject({ bills: 0, credit: 10500, total: -10500 });
    expect((await analytics()).totals).toEqual({ orderCount: 0, qty: -3, totalPaise: -10500 });
  });

  it("subtracts a partial refund today from today's net sales, GST and collections by method", async () => {
    const b = await bill("upi");
    await refund(b.id, 1, [{ mode: "upi", amountPaise: 3499 }]);
    const report = await dayEnd(today);
    expect(report.sales).toMatchObject({ billCount: 1, totalPaise: 10500 });
    expect(report.taxes).toEqual([{ gstRate: 5, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250 }]);
    expect(report.creditNotes).toEqual({ count: 1, taxablePaise: 3333, cgstPaise: 83, sgstPaise: 83, totalPaise: 3499,
      taxes: [{ gstRate: 5, taxablePaise: 3333, cgstPaise: 83, sgstPaise: 83 }] });
    expect(report.net).toEqual({ totalPaise: 7001, taxablePaise: 6666, cgstPaise: 167, sgstPaise: 167 });
    expect(report.payments).toEqual([{ mode: "upi", amountPaise: 10500 }]);
    expect(report.refunds).toEqual([{ mode: "upi", amountPaise: 3499 }]);
    expect(report.netPayments).toEqual([{ mode: "upi", amountPaise: 7001 }]);

    const day = (await sales(today, today)).daily[0];
    expect(day).toMatchObject({ creditNotePaise: 3499, netTotalPaise: 7001, collections: { upiPaise: 7001, refundPaise: 3499, totalPaise: 7001 } });
  });

  it("counts void bills as issued on their date and nets a same-day void to zero", async () => {
    const unpaid = await bill(false);
    await voidBill(unpaid.id, []);
    const report = await dayEnd(today);
    expect(report.sales).toMatchObject({ billCount: 1, totalPaise: 10500, outstandingPaise: 0 });
    expect(report.creditNotes).toMatchObject({ count: 1, totalPaise: 10500 });
    expect(report.refunds).toEqual([]);
    expect(report.net).toEqual({ totalPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 });
  });

  it("nets item and category quantities and sales after a partial refund", async () => {
    const b = await bill("cash");
    await refund(b.id, 1, [{ mode: "cash", amountPaise: 3499 }]);
    const [items, categories] = (await operations("items")).tables;
    expect(items!.rows).toEqual([expect.objectContaining({ name: "Thali", category: "Food", qty: 3, bills: 1, total: 10500, creditQty: 1, credit: 3499, netQty: 2, netTotal: 7001 })]);
    expect(items!.totals).toMatchObject({ qty: 3, creditQty: 1, netQty: 2, total: 10500, credit: 3499, netTotal: 7001, bills: 1 });
    expect(categories!.rows).toEqual([expect.objectContaining({ category: "Food", netQty: 2, netTotal: 7001 })]);
    const result = await analytics();
    expect(result.totals).toEqual({ orderCount: 1, qty: 2, totalPaise: 7001 });
    expect(result.items[0]).toMatchObject({ name: "Thali", qty: 2, totalPaise: 7001, takeawayQty: 2 });
    expect(result.categories[0]).toMatchObject({ name: "Food", qty: 2, totalPaise: 7001 });
    expect(result.daily.reduce((n, d) => n + d.totalPaise, 0)).toBe(7001);
    expect(result.hourly.reduce((n, h) => n + h.totalPaise, 0)).toBe(7001);
    expect((await operations("hourly")).tables[0]!.totals).toMatchObject({ bills: 1, credit: 3499, total: 7001 });
  });

  it("subtracts refunds from the requesting cashier's collections", async () => {
    const b = await bill("cash", cashier.token);
    await refund(b.id, 1, [{ mode: "cash", amountPaise: 3499 }]);
    const other = await bill("card", cashier.token);
    await refund(other.id, 1, [{ mode: "card", amountPaise: 3499 }], admin.token);
    const table = (await operations("cashiers")).tables[0]!;
    expect(table.rows).toEqual([
      { cashier: "Cara", bills: 2, cash: 7001, upi: 0, card: 10500, refunds: 3499, total: 17501 },
      { cashier: "Asha", bills: 0, cash: 0, upi: 0, card: -3499, refunds: 3499, total: -3499 },
    ]);
    expect(table.totals).toMatchObject({ cashier: "Total", bills: 2, cash: 7001, card: 7001, refunds: 6998, total: 14002 });
  });

  it("lists every credit note in the credit-notes report with both names", async () => {
    const b = await bill("cash");
    await refund(b.id, 1, [{ mode: "cash", amountPaise: 3499 }]);
    const unpaid = await bill(false);
    await voidBill(unpaid.id, []);
    const report = await operations("credit-notes");
    expect(report.kind).toBe("credit-notes");
    const table = report.tables[0]!;
    expect(table.columns.map((c) => c.key)).toEqual(["cnNo", "date", "billNo", "kind", "reason", "requestedBy", "approvedBy", "refundModes", "taxable", "gst", "total"]);
    expect(table.rows).toEqual([
      { cnNo: "CN-1", date: expect.any(Number), billNo: b.billNo, kind: "Refund", reason: "Cold food", requestedBy: "Cara", approvedBy: "Asha", refundModes: "Cash", taxable: 3333, gst: 166, total: 3499 },
      { cnNo: "CN-2", date: expect.any(Number), billNo: unpaid.billNo, kind: "Void", reason: "Wrong bill", requestedBy: "Asha", approvedBy: "Asha", refundModes: "None", taxable: 9999, gst: 500, total: 10500 },
    ]);
    expect(table.totals).toMatchObject({ cnNo: "Total", taxable: 13332, gst: 666, total: 13999 });
    expect((await operations("credit-notes", yesterday, yesterday)).tables[0]!.rows).toEqual([]);
  });
});
