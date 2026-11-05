import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { financialYear, uuidv7, type Bill } from "@masalapos/domain";
import type { GstReturnsReport } from "@masalapos/domain/gst-returns";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

const OWN = "29AAPFU0939F1ZR";
const ACME = { gstin: "29AABCU9603R1ZJ", name: "Acme Pvt Ltd" };
const JAN = new Date(2026, 0, 15, 12).getTime();
const FEB = new Date(2026, 1, 10, 12).getTime();

/** GST returns from real bills: B2B and B2C, credit notes by their own date, cancelled invoices, and the GSTR-1 file. */
describe("GST returns", () => {
  let app: FastifyInstance;
  let token: string;
  let productId: string;

  beforeEach(async () => {
    app = freshApp();
    token = (await setupAdmin(app)).token;
    app.db.prepare("UPDATE settings SET gstin = ? WHERE id = 1").run(OWN);
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    // ₹105 including 5% GST: taxable ₹100, CGST ₹2.50, SGST ₹2.50.
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: category.json().category.id, pricePaise: 10500, gstRate: 5, kotStationId: null } });
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  async function bill(qty: number, at: number, buyer?: typeof ACME): Promise<Bill> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId, qty, clientRef: uuidv7() }] } });
    const payload = buyer ? { buyer } : {};
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload });
    const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload: { ...payload, clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    expect(issued.statusCode, issued.body).toBe(201);
    const b = issued.json().bill as Bill;
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at, b.id);
    return b;
  }
  async function voidBill(billId: string, at: number) {
    const res = await app.inject({ method: "POST", url: `/api/bills/${billId}/void`, headers: auth(token), payload: { clientRef: uuidv7(), reason: "Wrong bill", refunds: [] } });
    expect(res.statusCode, res.body).toBe(201);
    // Credit notes are append-only; move this one into the test's month the way a real clock would have dated it.
    app.db.exec("DROP TRIGGER IF EXISTS credit_notes_no_update");
    app.db.prepare("UPDATE credit_notes SET created_at = ? WHERE bill_id = ?").run(at, billId);
  }
  const report = async (period: string, span = "month") => {
    const res = await app.inject({ url: `/api/reports/gst-returns?period=${period}&span=${span}`, headers: auth(token) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().report as GstReturnsReport;
  };
  const table = (r: GstReturnsReport, part: string) => r.tables.find((t) => t.title.includes(part))!;

  it("reports B2B and B2C bills, and a same-month void as a cancelled invoice", async () => {
    await bill(2, JAN);
    await bill(1, JAN, ACME);
    const voided = await bill(1, JAN);
    await voidBill(voided.id, JAN);
    const r = await report("2026-01");
    expect(r).toMatchObject({ regime: "regular", gstr1Available: true, warnings: [] });
    expect(table(r, "Table 7").rows).toEqual([{ pos: "29-Karnataka", type: "OE", rate: "5%", taxable: 20000, cgst: 500, sgst: 500 }]);
    expect(table(r, "Table 4A").rows).toMatchObject([{ ctin: ACME.gstin, buyer: ACME.name, value: 10500, taxable: 10000 }]);
    expect(table(r, "Table 13").rows[0]).toMatchObject({ total: 3, cancelled: 1, net: 2 });
    expect(table(r, "Table 3.1").rows[0]).toMatchObject({ taxable: 30000, cgst: 750, sgst: 750 });
  });

  it("reports a later void as a credit note in its own month, leaving the bill's month unchanged", async () => {
    const business = await bill(1, JAN, ACME);
    const before = await report("2026-01");
    await voidBill(business.id, FEB);
    expect((await report("2026-01")).tables).toEqual(before.tables);
    const feb = await report("2026-02");
    expect(table(feb, "Table 9B").rows).toMatchObject([{ ctin: ACME.gstin, bill: business.invoiceNo, taxable: 10000 }]);
    expect(table(feb, "Table 3.1").rows[0]).toMatchObject({ taxable: -10000 });
    const quarter = await report("2026-02", "quarter");
    expect(quarter.period).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
    expect(table(quarter, "Table 13").rows[0]).toMatchObject({ total: 1, cancelled: 1 });
  });

  it("reports stored invoice numbers, one range per prefix, and credit note references", async () => {
    const setPrefix = (invoicePrefix: string) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe", gstin: OWN, invoicePrefix } });
    const fy = financialYear(Date.now()).short;
    expect((await setPrefix("MP")).statusCode).toBe(200);
    await bill(1, JAN);
    const second = await bill(1, JAN, ACME);
    expect((await setPrefix("X1")).statusCode).toBe(200);
    const third = await bill(1, JAN);
    await voidBill(third.id, JAN);
    const r = await report("2026-01");
    expect(table(r, "Table 13").rows).toEqual([
      { document: "Invoices for outward supply", from: `MP/${fy}/0001`, to: `MP/${fy}/0002`, total: 2, cancelled: 0, net: 2 },
      { document: "Invoices for outward supply", from: `X1/${fy}/0003`, to: `X1/${fy}/0003`, total: 1, cancelled: 1, net: 0 },
      { document: "Credit notes", from: `CN/${fy}/001`, to: `CN/${fy}/001`, total: 1, cancelled: 0, net: 1 },
    ]);
    expect(second.invoiceNo).toBe(`MP/${fy}/0002`);
    expect(table(r, "Table 4A").rows).toMatchObject([{ invoice: `MP/${fy}/0002` }]);
  });

  it("downloads the GSTR-1 JSON with the GSTIN and period in its name", async () => {
    await bill(1, JAN, ACME);
    const res = await app.inject({ url: "/api/reports/gst-returns/gstr1.json?period=2026-01", headers: auth(token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="GSTR1_${OWN}_012026.json"`);
    expect(res.json()).toMatchObject({ gstin: OWN, fp: "012026", b2b: [{ ctin: ACME.gstin }] });
  });

  it("reports a bill with GST added on top as a regular taxable supply", async () => {
    app.db.prepare("UPDATE settings SET gst_mode = 'exclusive' WHERE id = 1").run();
    await bill(2, JAN);
    const r = await report("2026-01");
    expect(r.regime).toBe("regular");
    // 2 x ₹105 before GST: CGST = SGST = round-half-up(525.0) = 525.
    expect(table(r, "Table 7").rows).toEqual([{ pos: "29-Karnataka", type: "OE", rate: "5%", taxable: 21000, cgst: 525, sgst: 525 }]);
    expect(table(r, "Table 3.1").rows[0]).toMatchObject({ taxable: 21000, cgst: 525, sgst: 525 });
    expect(r.tables.some((t) => t.title.includes("CMP-08"))).toBe(false);
  });

  it("shows CMP-08 to a composition restaurant and refuses it the GSTR-1 file", async () => {
    app.db.prepare("UPDATE settings SET gst_mode = 'none' WHERE id = 1").run();
    await bill(2, JAN);
    const r = await report("2026-01", "quarter");
    expect(r.regime).toBe("composition");
    expect(table(r, "CMP-08").totals).toMatchObject({ net: 21000, cgst: 525, sgst: 525 });
    expect((await app.inject({ url: "/api/reports/gst-returns/gstr1.json?period=2026-01", headers: auth(token) })).statusCode).toBe(409);
  });

  it("refuses the file for a GSTIN that fails the check character", async () => {
    app.db.prepare("UPDATE settings SET gstin = '29ABCDE1234F1Z5' WHERE id = 1").run();
    const r = await report("2026-01");
    expect(r.gstr1Available).toBe(false);
    expect((await app.inject({ url: "/api/reports/gst-returns/gstr1.json?period=2026-01", headers: auth(token) })).statusCode).toBe(409);
  });

  it("works without the Reports module, needs the report permission, and checks the period", async () => {
    app.db.prepare("UPDATE settings SET gstin = '' WHERE id = 1").run();
    expect((await report("2026-01")).regime).toBe("unregistered");
    const kitchen = await createUser(app, token, { name: "Kiran", pin: "4321", role: "kitchen" });
    expect((await app.inject({ url: "/api/reports/gst-returns?period=2026-01", headers: auth(kitchen.token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/reports/gst-returns?period=2026-13", headers: auth(token) })).statusCode).toBe(400);
  });
});
