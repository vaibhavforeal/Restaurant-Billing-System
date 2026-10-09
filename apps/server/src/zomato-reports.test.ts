import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@forkflow/domain";
import { auth, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => { await app?.close(); });

const NINE_FIVE = "Aggregator supplies — GST paid by Zomato (section 9(5))";

async function post(token: string, url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
}

/** One cash takeaway and one picked-up Zomato order (Rs 580), both issued today. */
async function seed() {
  app = freshApp();
  const admin = await setupAdmin(app);
  enableIntegration(app, "zomato");
  const { category } = await post(admin.token, "/api/categories", { name: "Mains" });
  const { product: meal } = await post(admin.token, "/api/products", { name: "Meal", categoryId: category.id, pricePaise: 30000, gstRate: 5, kotStationId: null });
  const { product: thali } = await post(admin.token, "/api/products", { name: "Thali", categoryId: category.id, pricePaise: 50000, zomatoPricePaise: 58000, gstRate: 5, kotStationId: null });

  const { order: parcel } = await post(admin.token, "/api/orders", { clientRef: uuidv7(), type: "parcel" });
  await post(admin.token, `/api/orders/${parcel.id}/items`, { items: [{ clientRef: uuidv7(), productId: meal.id, qty: 1 }] });
  const { preview } = await post(admin.token, `/api/orders/${parcel.id}/bill-preview`, {});
  const { bill: takeaway } = await post(admin.token, `/api/orders/${parcel.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
  await post(admin.token, `/api/bills/${takeaway.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: takeaway.totalPaise }] });

  const { order: zomato } = await post(admin.token, "/api/orders", { clientRef: uuidv7(), type: "zomato", zomatoOrderId: "5821" });
  await post(admin.token, `/api/orders/${zomato.id}/items`, { items: [{ clientRef: uuidv7(), productId: thali.id, qty: 1 }] });
  await post(admin.token, `/api/orders/${zomato.id}/zomato-status`, { status: "ready", clientRef: uuidv7() });
  const { bill: zomatoBill } = await post(admin.token, `/api/orders/${zomato.id}/zomato-status`, { status: "picked_up", clientRef: uuidv7() });
  return { admin, takeaway, zomatoBill };
}
const get = async (token: string, url: string) => {
  const res = await app.inject({ url, headers: auth(token) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

describe("Zomato in reports", () => {
  it("keeps the Zomato receivable out of day-end cash and reports it separately", async () => {
    const { admin, takeaway, zomatoBill } = await seed();
    expect(zomatoBill.totalPaise).toBe(58000);
    const { report } = await get(admin.token, "/api/reports/day-end");
    expect(report.zomatoReceivablePaise).toBe(58000);
    expect(report.netPayments).toEqual([{ mode: "cash", amountPaise: takeaway.totalPaise }]);
    expect(report.payments).toEqual([{ mode: "cash", amountPaise: takeaway.totalPaise }]);
    // Net sales and bill counts still include the Zomato bill.
    expect(report.sales).toMatchObject({ billCount: 2, totalPaise: takeaway.totalPaise + 58000 });
  });

  it("reports a zero Zomato receivable when there are no Zomato payments", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { report } = await get(admin.token, "/api/reports/day-end");
    expect(report.zomatoReceivablePaise).toBe(0);
    expect(report.zomatoSuppliesPaise).toBe(0);
  });

  it("keeps section 9(5) supplies out of the day-end GST breakdown and net taxable value, on a line of their own", async () => {
    const { admin, takeaway, zomatoBill } = await seed();
    const { report } = await get(admin.token, "/api/reports/day-end");
    // Only the takeaway is the restaurant's own taxable supply.
    expect(report.taxes).toEqual(takeaway.taxes);
    expect(report.net.taxablePaise).toBe(takeaway.taxes.reduce((sum: number, t: { taxablePaise: number }) => sum + t.taxablePaise, 0));
    expect(report.net).toMatchObject({ cgstPaise: takeaway.cgstPaise, sgstPaise: takeaway.sgstPaise, totalPaise: takeaway.totalPaise + zomatoBill.totalPaise });
    expect(report.zomatoSuppliesPaise).toBe(58000);
    // A Zomato bill carries no GST either, but it is a 9(5) supply, not a "Sales without GST" bill.
    expect(report.noGstSalesPaise).toBe(0);
  });

  it("excludes Zomato receivables from the sales and cashier collections", async () => {
    const { admin, takeaway } = await seed();
    const { report: sales } = await get(admin.token, "/api/reports/sales");
    expect(sales.collections).toMatchObject({ cashPaise: takeaway.totalPaise, totalPaise: takeaway.totalPaise });
    // Sales = collections + Zomato receivable + still unpaid, so the gap is explained.
    expect(sales.zomatoReceivablePaise).toBe(58000);
    expect(sales.daily.at(-1).zomatoReceivablePaise).toBe(58000);
    expect(sales.sales.totalPaise).toBe(sales.collections.totalPaise + sales.zomatoReceivablePaise + sales.sales.outstandingPaise);
    const { report: cashiers } = await get(admin.token, "/api/reports/operations/cashiers");
    expect(cashiers.tables[0].totals.total).toBe(takeaway.totalPaise);
  });

  it("lists Zomato bills in a section 9(5) table and keeps their GST out of the sales GST column", async () => {
    const { admin, takeaway, zomatoBill } = await seed();
    const { report } = await get(admin.token, "/api/reports/operations/items");
    const table = report.tables.find((t: { title: string }) => t.title === NINE_FIVE);
    expect(table).toBeDefined();
    expect(table.columns.map((c: { label: string }) => c.label)).toEqual(["Bill no.", "Zomato order", "Date", "Value"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ billNo: zomatoBill.billNo, zomatoOrderId: "5821", value: 58000 });
    expect(table.totals).toMatchObject({ value: 58000 });
    const itemSales = report.tables.find((t: { title: string }) => t.title === "Item sales");
    expect(itemSales.totals.gst).toBe(takeaway.cgstPaise + takeaway.sgstPaise);
    expect(itemSales.totals.gst).toBeGreaterThan(0);
  });

  it("filters analytics by Zomato and compares all three order types", async () => {
    const { admin } = await seed();
    const { report: zomato } = await get(admin.token, "/api/reports/analytics?type=zomato");
    expect(zomato.orderType).toBe("zomato");
    expect(zomato.totals).toMatchObject({ orderCount: 1, totalPaise: 58000, qty: 1 });
    expect(zomato.items).toEqual([expect.objectContaining({ name: "Thali", qty: 1, takeawayQty: 0, tableQty: 0 })]);
    const { report: all } = await get(admin.token, "/api/reports/analytics");
    expect(all.comparison.map((row: { type: string }) => row.type)).toEqual(["parcel", "dine_in", "zomato"]);
    expect(all.comparison.find((row: { type: string }) => row.type === "zomato")).toMatchObject({ orderCount: 1, totalPaise: 58000, qty: 1 });
    expect(all.totals.orderCount).toBe(2);
  });
});
