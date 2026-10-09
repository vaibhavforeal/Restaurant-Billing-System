import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill, type BillCreditNote } from "@forkflow/domain";
import { auth, freshAppWithFakeSink, setupAdmin } from "../test-helpers.js";
import { creditNoteHtml, creditNoteSlip, type CreditNoteView } from "./credit-note.js";
import { renderBytes } from "./render-bytes.js";

describe("credit note slip", () => {
  let app: FastifyInstance;
  let fake: ReturnType<typeof freshAppWithFakeSink>["fake"];
  let token: string;
  let productId: string;

  beforeEach(async () => {
    ({ app, fake } = freshAppWithFakeSink());
    ({ token } = await setupAdmin(app));
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: category.json().category.id, pricePaise: 3500, gstRate: 5, kotStationId: null } });
    expect(product.statusCode).toBe(201);
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  /** A paid bill of 3 thalis with one thali refunded in cash; returns the bill and the credit note's id. */
  async function refunded(reason = "Cold food"): Promise<{ bill: Bill; noteId: string }> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId, qty: 3, clientRef: uuidv7() }] } });
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(token), payload: {} });
    const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    const billId = issued.json().bill.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/bills/${billId}/settle`, headers: auth(token), payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: issued.json().bill.totalPaise }] } });
    expect(paid.statusCode).toBe(200);
    const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(billId) as { id: string }).id;
    const refund = await app.inject({ method: "POST", url: `/api/bills/${billId}/refund`, headers: auth(token),
      payload: { clientRef: uuidv7(), reason, lines: [{ orderItemId, qty: 1 }], refunds: [{ mode: "cash", amountPaise: 3499 }] } });
    expect(refund.statusCode, refund.body).toBe(201);
    return { bill: refund.json().bill as Bill, noteId: refund.json().creditNote.id as string };
  }
  const view = (note: BillCreditNote): CreditNoteView => ({ ...note, taxes: [{ gstRate: 5, taxablePaise: note.taxablePaise, cgstPaise: note.cgstPaise, sgstPaise: note.sgstPaise }] });

  it("prints the credit note slip with the bill reference, item, tax and total refunded", async () => {
    const { bill } = await refunded();
    const note = view(bill.creditNotes[0]!);
    for (const width of [58, 80] as const) {
      const rendered = renderBytes(creditNoteSlip(note, bill, width));
      expect(rendered).toContain("CREDIT NOTE CN-1");
      expect(rendered).toContain(`Bill #${bill.billNo}`);
      expect(rendered).toContain("Thali");
      expect(rendered).toContain("CGST @ 2.5%");
      expect(rendered).toContain("TOTAL REFUNDED");
      expect(rendered).toContain("34.99");
      expect(rendered).toContain("CASH");
      expect(rendered).toContain("Cold food");
      expect(rendered).toContain("Approved by Asha");
      expect(rendered.split("\n").every((line) => line.replace(/<[0-9A-F]{2}>/g, "").length <= (width === 58 ? 32 : 48))).toBe(true);
    }
  });

  it("prints no GST rows on a credit note against a bill that charged no GST", async () => {
    const { bill } = await refunded();
    const supply: Bill = { ...bill, receipt: { ...bill.receipt, gstMode: "none" as const } };
    const note: CreditNoteView = { ...bill.creditNotes[0]!, taxablePaise: 3333, cgstPaise: 0, sgstPaise: 0, totalPaise: 3333,
      taxes: [{ gstRate: 5, taxablePaise: 3333, cgstPaise: 0, sgstPaise: 0 }] };
    const html = creditNoteHtml(note, supply);
    expect(html).not.toMatch(/GST breakdown|CGST|SGST|Taxable/);
    expect(html).toContain("<td>Item value</td>"); expect(html).toContain("₹33.33");
    for (const width of [58, 80] as const) {
      const rendered = renderBytes(creditNoteSlip(note, supply, width));
      expect(rendered).not.toMatch(/CGST|SGST|Taxable/);
      expect(rendered).toContain("TOTAL REFUNDED"); expect(rendered).toContain("33.33");
    }
  });

  it("says BILL VOIDED for the void of an unpaid bill", async () => {
    const { bill } = await refunded();
    const note = { ...view(bill.creditNotes[0]!), kind: "void" as const, refunds: [] };
    const rendered = renderBytes(creditNoteSlip(note, bill, 58));
    expect(rendered).toContain("BILL VOIDED");
    expect(rendered).not.toContain("TOTAL REFUNDED");
  });

  it("escapes markup in the HTML and strips control bytes from the slip", async () => {
    const { bill } = await refunded();
    const note = { ...view(bill.creditNotes[0]!), reason: '<script>alert("x")</script>\x1b@' };
    const html = creditNoteHtml(note, bill);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("CN-1");
    expect(creditNoteSlip(note, bill, 58).indexOf(Buffer.from([27, 64]), 2)).toBe(-1);
  });

  it("serves the credit note receipt with the bill receipt's headers, loading per-rate taxes", async () => {
    const { noteId } = await refunded();
    const res = await app.inject({ url: `/api/credit-notes/${noteId}/receipt`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    expect(res.body).toContain("CN-1");
    expect(res.body).toContain("5%");
    expect(res.body).toContain("34.99");
    expect((await app.inject({ url: `/api/credit-notes/${uuidv7()}/receipt`, headers: auth(token) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/credit-notes/${noteId}/receipt` })).statusCode).toBe(401);
  });

  it("queues a credit_note print job on an active receipt printer", async () => {
    const { noteId } = await refunded();
    const p = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Receipt", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } });
    const res = await app.inject({ method: "POST", url: `/api/credit-notes/${noteId}/print`, headers: auth(token), payload: { printerId: p.json().printer.id } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ kind: "credit_note", label: "CN-1" });
    await expect.poll(() => fake.sent.length).toBeGreaterThan(0);
    expect(renderBytes(fake.sent.at(-1)!.bytes)).toContain("CREDIT NOTE CN-1");

    const bad = await app.inject({ method: "POST", url: `/api/credit-notes/${noteId}/print`, headers: auth(token), payload: { printerId: "nope" } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/api/credit-notes/${uuidv7()}/print`, headers: auth(token), payload: { printerId: p.json().printer.id } });
    expect(missing.statusCode).toBe(404);
  });
});
