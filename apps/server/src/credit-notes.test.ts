import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { uuidv7, type Bill, type BillCreditNote, type PayMode } from "@forkflow/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { loadBillCredit, resolveApprover } from "./credit-notes.js";

describe("credit preview, approval and bill credit data", () => {
  let app: FastifyInstance;
  let admin: { token: string; user: { id: string; name: string } };
  let cashier: { id: string; token: string };
  let categoryId: string;
  let productId: string;

  beforeEach(async () => {
    app = freshApp();
    admin = await setupAdmin(app);
    cashier = await createUser(app, admin.token, { name: "Cara", pin: "5678", role: "cashier" });
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(admin.token), payload: { name: "Food" } });
    categoryId = category.json().category.id;
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(admin.token), payload: { name: "Thali", categoryId, pricePaise: 3333, gstRate: 5, kotStationId: null } });
    expect(product.statusCode).toBe(201);
    productId = product.json().product.id;
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  /** An order of `qty` thalis, billed and optionally settled (in cash, or by `settle`'s mode) (3 x 3333 -> 10500 with 1 paise of rounding). */
  async function bill(qty = 3, settle: boolean | PayMode = true, tableId: string | null = null): Promise<Bill> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: tableId ? "dine_in" : "parcel", tableId } });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().order.id as string;
    const add = await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(admin.token), payload: { items: [{ productId, qty, clientRef: uuidv7() }] } });
    expect(add.statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(admin.token), payload: {} });
    const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(admin.token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    expect(issued.statusCode).toBe(201);
    const issuedBill = issued.json().bill as Bill;
    if (!settle) return issuedBill;
    const mode = settle === true ? "cash" : settle;
    const paid = await app.inject({ method: "POST", url: `/api/bills/${issuedBill.id}/settle`, headers: auth(admin.token), payload: { clientRef: uuidv7(), payments: [{ mode, amountPaise: issuedBill.totalPaise }] } });
    expect(paid.statusCode).toBe(200);
    return paid.json().bill as Bill;
  }
  const preview = (billId: string, payload: unknown, token = cashier.token) =>
    app.inject({ method: "POST", url: `/api/bills/${billId}/credit-preview`, headers: auth(token), payload: payload as object });

  /**
   * A bill issued before report lines existed: a bills row with taxes and a payment but no bill_report_lines.
   * `taxes` are the per-rate bill_taxes rows [rate, taxable, cgst, sgst]; `receipt` stores a receipt snapshot so the bill can be shown.
   */
  async function olderBill(opts: { taxes?: Array<[number, number, number, number]>; roundingPaise?: number; receipt?: boolean } = {}): Promise<string> {
    const { taxes = [[5, 10000, 250, 250]], roundingPaise = 0, receipt = false } = opts;
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    const id = uuidv7();
    const receiptJson = receipt ? JSON.stringify({ restaurantName: "Cafe Test", address: "", gstin: "", fssai: "", receiptFooter: "",
      taxInclusive: false, orderType: "parcel", tableName: null, splitLabel: null, items: [{ name: "Thali", qty: 3, pricePaise: 3333, gstRate: 5 }] }) : null;
    app.db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_at, created_by, receipt_json)
      VALUES (?, 900, ?, 10000, 0, 250, 250, ?, 10500, 'paid', ?, ?, ?)`).run(id, orderId, roundingPaise, Date.now(), admin.user.id, receiptJson);
    for (const [rate, taxable, cgst, sgst] of taxes) {
      app.db.prepare("INSERT INTO bill_taxes (id, bill_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv7(), id, rate, taxable, cgst, sgst);
    }
    app.db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, created_at) VALUES (?, ?, 'upi', 10500, ?)").run(uuidv7(), id, Date.now());
    return id;
  }
  const orderItemOf = (billId: string) => (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(billId) as { id: string }).id;
  /** An earlier credit note written straight to the tables (the refund route arrives later); keeps the CN sequence in step. */
  function priorCredit(billId: string, qty: number, t: [number, number, number, number, number], refunds: Array<[PayMode, number]>, kind = "refund"): void {
    const cnNo = (app.db.prepare("UPDATE sequences SET value = value + 1 WHERE name = 'credit_note_no' RETURNING value").get() as { value: number }).value;
    const cnId = uuidv7();
    app.db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, requested_by, approved_by, created_at, client_ref, request_json)
      VALUES (?, ?, ?, ?, 'Cold food', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`).run(cnId, cnNo, billId, kind, ...t, admin.user.id, admin.user.id, Date.now(), `prior-${cnId}`);
    app.db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_id, category_name, gst_rate, qty, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise)
      VALUES (?, ?, 'Thali', ?, 'Food', 5, ?, ?, ?, ?, ?, ?)`).run(cnId, orderItemOf(billId), categoryId, qty, ...t);
    for (const [mode, amount] of refunds) app.db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, created_at) VALUES (?, ?, ?, ?, ?)").run(uuidv7(), cnId, mode, amount, Date.now());
  }

  describe("POST /api/bills/:id/credit-preview", () => {
    it("previews a partial refund exactly and reports what is refundable per method", async () => {
      const b = await bill();
      const item = b.receipt.items[0]!;
      const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(b.id) as { id: string }).id;
      const res = await preview(b.id, { kind: "refund", lines: [{ orderItemId, qty: 1 }] });
      expect(res.statusCode, res.body).toBe(200);
      const { preview: p } = res.json();
      expect(p.totals).toEqual({ taxablePaise: 3333, cgstPaise: 83, sgstPaise: 83, roundingPaise: 0, totalPaise: 3499 });
      expect(p.taxes).toEqual([{ gstRate: 5, taxablePaise: 3333, cgstPaise: 83, sgstPaise: 83 }]);
      expect(p.lines).toHaveLength(1);
      expect(p.lines[0]).toMatchObject({ orderItemId, qty: 1, name: item.name, gstRate: 5, totalPaise: 3499 });
      expect(p.refundable).toEqual({ cash: 10500, upi: 0, card: 0, total: 10500 });
    });

    it("previews the void of a paid bill as everything not yet credited", async () => {
      const b = await bill();
      const res = await preview(b.id, { kind: "void" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().preview.totals).toEqual({ taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250, roundingPaise: 1, totalPaise: 10500 });
    });

    it("takes earlier credit notes into account", async () => {
      const b = await bill();
      const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(b.id) as { id: string }).id;
      const cnId = uuidv7();
      app.db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, requested_by, approved_by, created_at, client_ref, request_json)
        VALUES (?, 1, ?, 'refund', 'x', 3333, 83, 83, 0, 3499, ?, ?, ?, 'ref-0000001', '{}')`).run(cnId, b.id, admin.user.id, admin.user.id, Date.now());
      app.db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_id, category_name, gst_rate, qty, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise)
        VALUES (?, ?, 'Thali', ?, 'Food', 5, 1, 3333, 83, 83, 0, 3499)`).run(cnId, orderItemId, categoryId);
      app.db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, created_at) VALUES (?, ?, 'cash', 3499, ?)").run(uuidv7(), cnId, Date.now());

      const res = await preview(b.id, { kind: "void" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().preview.totals).toEqual({ taxablePaise: 6666, cgstPaise: 167, sgstPaise: 167, roundingPaise: 1, totalPaise: 7001 });
      expect(res.json().preview.refundable).toEqual({ cash: 7001, upi: 0, card: 0, total: 7001 });

      const tooMany = await preview(b.id, { kind: "refund", lines: [{ orderItemId, qty: 3 }] });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().error).toMatch(/only 2 left/);
    });

    it("refuses a refund on a bill that is not paid", async () => {
      const b = await bill(3, false);
      const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(b.id) as { id: string }).id;
      expect((await preview(b.id, { kind: "refund", lines: [{ orderItemId, qty: 1 }] })).statusCode).toBe(409);
      const voidPreview = await preview(b.id, { kind: "void" });
      expect(voidPreview.statusCode).toBe(200);
      expect(voidPreview.json().preview.refundable).toEqual({ cash: 0, upi: 0, card: 0, total: 0 });
    });

    it("rejects a refund without lines and unknown items", async () => {
      const b = await bill();
      expect((await preview(b.id, { kind: "refund" })).statusCode).toBe(400);
      const unknown = await preview(b.id, { kind: "refund", lines: [{ orderItemId: "nope", qty: 1 }] });
      expect(unknown.statusCode).toBe(400);
      expect((await preview("missing", { kind: "void" })).statusCode).toBe(404);
    });

    it("lets an older bill without stored lines be voided but not partly refunded", async () => {
      const id = await olderBill();
      const refund = await preview(id, { kind: "refund", lines: [{ orderItemId: "x", qty: 1 }] });
      expect(refund.statusCode).toBe(409);
      expect(refund.json().error).toBe("This older bill can only be voided");

      const voided = await preview(id, { kind: "void" });
      expect(voided.statusCode, voided.body).toBe(200);
      const { preview: p } = voided.json();
      expect(p.lines).toEqual([]);
      expect(p.taxes).toEqual([{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]);
      expect(p.totals).toEqual({ taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, roundingPaise: 0, totalPaise: 10500 });
      expect(p.refundable).toEqual({ cash: 0, upi: 10500, card: 0, total: 10500 });
    });

    it("says nothing is left to refund once the bill is fully credited", async () => {
      const b = await bill();
      priorCredit(b.id, 3, [9999, 250, 250, 1, 10500], [["cash", 10500]]);
      const orderItemId = orderItemOf(b.id);
      for (const payload of [{ kind: "refund", lines: [{ orderItemId, qty: 1 }] }, { kind: "void" }]) {
        const res = await preview(b.id, payload);
        expect(res.statusCode, payload.kind).toBe(409);
        expect(res.json().error).toBe("Nothing left to refund on this bill");
      }
    });

    it("takes an older bill's void taxable from its per-rate taxes, so the totals match the taxes exactly", async () => {
      // bills.rounding_paise disagrees with bill_taxes here: the taxes add up to 9999 + 250 + 250, the bill to 10500.
      const id = await olderBill({ taxes: [[5, 5999, 150, 150], [12, 4000, 100, 100]], roundingPaise: 0 });
      const res = await preview(id, { kind: "void" });
      expect(res.statusCode, res.body).toBe(200);
      const { preview: p } = res.json();
      expect(p.taxes).toEqual([{ gstRate: 5, taxablePaise: 5999, cgstPaise: 150, sgstPaise: 150 }, { gstRate: 12, taxablePaise: 4000, cgstPaise: 100, sgstPaise: 100 }]);
      expect(p.totals).toEqual({ taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250, roundingPaise: 1, totalPaise: 10500 });
    });

    it("is not available to a waiter", async () => {
      const b = await bill();
      const waiter = await createUser(app, admin.token, { name: "Wally", pin: "9012", role: "waiter" });
      expect((await preview(b.id, { kind: "void" }, waiter.token)).statusCode).toBe(403);
    });

    it("writes nothing", async () => {
      const b = await bill();
      await preview(b.id, { kind: "void" });
      expect((app.db.prepare("SELECT COUNT(*) AS n FROM credit_notes").get() as { n: number }).n).toBe(0);
      expect((app.db.prepare("SELECT status FROM bills WHERE id = ?").get(b.id) as { status: string }).status).toBe("paid");
    });
  });

  describe("POST /api/bills/:id/void", () => {
    const count = (sql: string, ...args: unknown[]) => (app.db.prepare(sql).get(...args) as { n: number }).n;
    const voidBill = (billId: string, payload: Record<string, unknown>, token = cashier.token) =>
      app.inject({ method: "POST", url: `/api/bills/${billId}/void`, headers: auth(token), payload: { clientRef: uuidv7(), reason: "Wrong table", approverPin: "1234", ...payload } });
    /** Capture broadcasts from here on. */
    function recordBroadcasts(): Array<{ event: string; data: Record<string, unknown> }> {
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const original = app.broadcast;
      app.broadcast = ((event: string, data: unknown) => { events.push({ event, data: data as Record<string, unknown> }); return original.call(app, event, data as never); }) as typeof app.broadcast;
      return events;
    }
    async function table(name: string): Promise<string> {
      const res = await app.inject({ method: "POST", url: "/api/tables", headers: auth(admin.token), payload: { name } });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().table.id as string;
    }
    const tableStatus = async (id: string) =>
      ((await app.inject({ url: "/api/tables", headers: auth(admin.token) })).json().tables as Array<{ id: string; status: string }>).find((t) => t.id === id)!.status;

    it("voids an unpaid table bill: a credit note with no refunds, the order cancelled and its tables freed", async () => {
      const t1 = await table("T1"), t2 = await table("T2");
      const b = await bill(3, false, t1);
      app.db.prepare("INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)").run(uuidv7(), t2, b.orderId, Date.now(), admin.user.id);
      expect(await tableStatus(t1)).toBe("billed");
      expect(await tableStatus(t2)).toBe("billed");
      const stockMovesBefore = count("SELECT COUNT(*) AS n FROM stock_moves");
      const events = recordBroadcasts();

      const res = await voidBill(b.id, { reason: "Wrong table" });
      expect(res.statusCode, res.body).toBe(201);
      const { bill: voided, creditNote, order } = res.json() as { bill: Bill; creditNote: BillCreditNote; order: { id: string; status: string; closedAt: number | null } };
      expect(creditNote).toMatchObject({ cnNo: 1, kind: "void", reason: "Wrong table", totalPaise: 10500, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250,
        requestedByName: "Cara", approvedByName: "Asha", refunds: [], lines: [{ orderItemId: orderItemOf(b.id), name: "Thali", qty: 3, totalPaise: 10500 }] });
      expect(voided).toMatchObject({ id: b.id, status: "void", totalPaise: 10500, refundState: "refunded", refundedQty: { [orderItemOf(b.id)]: 3 } });
      expect(voided.creditNotes).toEqual([creditNote]);
      expect(order).toMatchObject({ id: b.orderId, status: "cancelled" });
      expect(order.closedAt).toEqual(expect.any(Number));

      const row = app.db.prepare("SELECT kind, rounding_paise, requested_by, approved_by, request_json FROM credit_notes WHERE id = ?").get(creditNote.id) as Record<string, unknown>;
      expect(row).toMatchObject({ kind: "void", rounding_paise: 1, requested_by: cashier.id, approved_by: admin.user.id });
      expect(row.request_json).not.toContain("1234");
      expect(app.db.prepare("SELECT gst_rate, taxable_paise, cgst_paise, sgst_paise FROM credit_note_taxes WHERE credit_note_id = ?").all(creditNote.id))
        .toEqual([{ gst_rate: 5, taxable_paise: 9999, cgst_paise: 250, sgst_paise: 250 }]);
      expect(count("SELECT COUNT(*) AS n FROM refund_payments")).toBe(0);
      expect(app.db.prepare("SELECT status, cancel_reason, cancelled_by FROM orders WHERE id = ?").get(b.orderId)).toEqual({ status: "cancelled", cancel_reason: "Wrong table", cancelled_by: cashier.id });
      // the bill's own money is never edited
      expect(app.db.prepare("SELECT total_paise, rounding_paise FROM bills WHERE id = ?").get(b.id)).toEqual({ total_paise: 10500, rounding_paise: 1 });
      expect(count("SELECT COUNT(*) AS n FROM stock_moves")).toBe(stockMovesBefore);

      expect(await tableStatus(t1)).toBe("free");
      expect(await tableStatus(t2)).toBe("free");
      expect(events.filter((e) => e.event === "order.updated").map((e) => (e.data.order as { status: string }).status)).toEqual(["cancelled"]);
      expect(events.filter((e) => e.event === "table.changed").map((e) => e.data.tableId).sort()).toEqual([t1, t2].sort());
    });

    it("voids a paid bill, refunding the whole amount by UPI", async () => {
      const b = await bill(3, "upi");
      const res = await voidBill(b.id, { refunds: [{ mode: "upi", amountPaise: 10500, refNote: "UPI ref 42" }] });
      expect(res.statusCode, res.body).toBe(201);
      const { bill: voided, creditNote, order } = res.json() as { bill: Bill; creditNote: BillCreditNote; order: { status: string } };
      expect(creditNote).toMatchObject({ cnNo: 1, kind: "void", totalPaise: b.totalPaise, refunds: [{ mode: "upi", amountPaise: 10500, refNote: "UPI ref 42" }] });
      expect(voided.status).toBe("void");
      expect(order.status).toBe("settled");
      expect(app.db.prepare("SELECT mode, amount_paise, ref_note FROM refund_payments WHERE credit_note_id = ?").all(creditNote.id))
        .toEqual([{ mode: "upi", amount_paise: 10500, ref_note: "UPI ref 42" }]);
    });

    it("lets an admin approve their own void without a PIN", async () => {
      const b = await bill();
      const res = await voidBill(b.id, { approverPin: undefined, refunds: [{ mode: "cash", amountPaise: 10500 }] }, admin.token);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().creditNote).toMatchObject({ requestedByName: "Asha", approvedByName: "Asha" });
    });

    it("refuses a cashier without a PIN or with a wrong PIN, writing nothing", async () => {
      const b = await bill();
      const noPin = await voidBill(b.id, { approverPin: undefined, refunds: [{ mode: "cash", amountPaise: 10500 }] });
      expect(noPin.statusCode).toBe(403);
      const wrong = await voidBill(b.id, { approverPin: "0000", refunds: [{ mode: "cash", amountPaise: 10500 }] });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error).toBe("Admin PIN is incorrect");
      expect(count("SELECT COUNT(*) AS n FROM credit_notes")).toBe(0);
      expect((app.db.prepare("SELECT status FROM bills WHERE id = ?").get(b.id) as { status: string }).status).toBe("paid");
    });

    it("is not available to a waiter", async () => {
      const b = await bill();
      const waiter = await createUser(app, admin.token, { name: "Wally", pin: "9012", role: "waiter" });
      expect((await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 10500 }] }, waiter.token)).statusCode).toBe(403);
    });

    it("after a partial refund credits only the remainder and refunds only the money still held", async () => {
      const b = await bill();
      priorCredit(b.id, 1, [3333, 83, 83, 0, 3499], [["cash", 3499]]);

      const short = await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 7000 }] });
      expect(short.statusCode).toBe(400);
      expect(short.json().error).toBe("Refund amounts must equal the credit note total");
      // what the counter saw before the earlier refund: the bill changed since
      const stale = await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 10500 }] });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("This bill changed — review again");

      const res = await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 7001 }] });
      expect(res.statusCode, res.body).toBe(201);
      const { bill: voided, creditNote } = res.json() as { bill: Bill; creditNote: BillCreditNote };
      expect(creditNote).toMatchObject({ cnNo: 2, kind: "void", totalPaise: 7001, taxablePaise: 6666, cgstPaise: 167, sgstPaise: 167,
        lines: [{ qty: 2, totalPaise: 7001 }], refunds: [{ mode: "cash", amountPaise: 7001, refNote: null }] });
      expect(voided.creditNotes.reduce((s, n) => s + n.totalPaise, 0)).toBe(voided.totalPaise);
      expect(voided.refundedQty).toEqual({ [orderItemOf(b.id)]: 3 });
    });

    it("keeps refunds within what each method paid and refuses refunds on an unpaid bill", async () => {
      const b = await bill(3, "cash");
      const byUpi = await voidBill(b.id, { refunds: [{ mode: "upi", amountPaise: 10500 }] });
      expect(byUpi.statusCode).toBe(400);
      expect(byUpi.json().error).toBe("Refund by upi cannot exceed what was paid by upi");
      const split = await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 10000 }, { mode: "card", amountPaise: 500 }] });
      expect(split.statusCode).toBe(400);
      expect(split.json().error).toBe("Refund by card cannot exceed what was paid by card");
      const short = await voidBill(b.id, { refunds: [{ mode: "cash", amountPaise: 10000 }] });
      expect(short.statusCode).toBe(400);
      expect(short.json().error).toBe("Refund amounts must equal the credit note total");
      // no refund on a paid bill: the counter saw it unpaid, so it was settled since
      const none = await voidBill(b.id, { refunds: [] });
      expect(none.statusCode).toBe(409);
      expect(none.json().error).toBe("This bill changed — review again");

      const unpaid = await bill(3, false);
      const withRefund = await voidBill(unpaid.id, { refunds: [{ mode: "cash", amountPaise: 10500 }] });
      expect(withRefund.statusCode).toBe(400);
      expect(withRefund.json().error).toBe("An unpaid bill has no payments to refund");
      expect(count("SELECT COUNT(*) AS n FROM credit_notes")).toBe(0);
    });

    it("splits a refund across methods within what each paid", async () => {
      const issued = await bill(3, false);
      const paid = await app.inject({ method: "POST", url: `/api/bills/${issued.id}/settle`, headers: auth(admin.token),
        payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 6000 }, { mode: "card", amountPaise: 4500 }] } });
      expect(paid.statusCode, paid.body).toBe(200);
      const res = await voidBill(issued.id, { refunds: [{ mode: "card", amountPaise: 4500 }, { mode: "cash", amountPaise: 6000 }] });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().creditNote.refunds).toEqual([{ mode: "card", amountPaise: 4500, refNote: null }, { mode: "cash", amountPaise: 6000, refNote: null }]);
    });

    it("answers a retry with the same credit note and refuses a reused reference with a different body", async () => {
      const b = await bill();
      const payload = { clientRef: "void-ref-0001", refunds: [{ mode: "cash", amountPaise: 10500 }] };
      const first = await voidBill(b.id, payload);
      expect(first.statusCode, first.body).toBe(201);
      const events = recordBroadcasts();
      const again = await voidBill(b.id, payload);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().creditNote).toEqual(first.json().creditNote);
      expect(again.json().creditNote.cnNo).toBe(1);
      expect(again.json().bill).toEqual(first.json().bill);
      expect(events).toEqual([]);
      expect(count("SELECT COUNT(*) AS n FROM credit_notes")).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM refund_payments")).toBe(1);
      expect(count("SELECT value AS n FROM sequences WHERE name = 'credit_note_no'")).toBe(1);

      const changed = await voidBill(b.id, { ...payload, reason: "Something else" });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error).toBe("Credit note reference already used for a different request");
      const otherBill = await bill();
      const elsewhere = await voidBill(otherBill.id, payload);
      expect(elsewhere.statusCode).toBe(409);
      expect(elsewhere.json().error).toBe("Credit note reference already used for a different request");
      expect(count("SELECT COUNT(*) AS n FROM credit_notes")).toBe(1);
    });

    it("refuses to void a void bill or a fully refunded one", async () => {
      const b = await bill(3, false);
      expect((await voidBill(b.id, {})).statusCode).toBe(201);
      const twice = await voidBill(b.id, {});
      expect(twice.statusCode).toBe(409);
      expect(twice.json().error).toBe("This bill is already void");

      const refunded = await bill();
      priorCredit(refunded.id, 3, [9999, 250, 250, 1, 10500], [["cash", 10500]]);
      const nothing = await voidBill(refunded.id, { refunds: [] });
      expect(nothing.statusCode).toBe(409);
      expect(nothing.json().error).toBe("Nothing left to refund on this bill");
      expect((await voidBill("missing", {})).statusCode).toBe(404);
    });

    it("leaves a voided bill unsettleable", async () => {
      const b = await bill(3, false);
      expect((await voidBill(b.id, {})).statusCode).toBe(201);
      const settle = await app.inject({ method: "POST", url: `/api/bills/${b.id}/settle`, headers: auth(admin.token), payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 10500 }] } });
      expect(settle.statusCode).toBe(409);
      expect(count("SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?", b.id)).toBe(0);
    });

    it("voids an older bill without stored lines from its bill totals and taxes", async () => {
      const id = await olderBill({ receipt: true });
      const res = await voidBill(id, { refunds: [{ mode: "upi", amountPaise: 10500 }] });
      expect(res.statusCode, res.body).toBe(201);
      const creditNote = res.json().creditNote as BillCreditNote;
      expect(creditNote).toMatchObject({ totalPaise: 10500, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, lines: [] });
      expect(app.db.prepare("SELECT gst_rate, taxable_paise FROM credit_note_taxes WHERE credit_note_id = ?").all(creditNote.id)).toEqual([{ gst_rate: 5, taxable_paise: 10000 }]);
      expect(res.json().bill.status).toBe("void");
    });

    it("writes nothing when the bill cannot be shown afterwards (no saved receipt)", async () => {
      const id = await olderBill();
      const res = await voidBill(id, { refunds: [{ mode: "upi", amountPaise: 10500 }] });
      expect(res.statusCode).toBe(409);
      expect(count("SELECT COUNT(*) AS n FROM credit_notes")).toBe(0);
      expect(count("SELECT value AS n FROM sequences WHERE name = 'credit_note_no'")).toBe(0);
      expect((app.db.prepare("SELECT status FROM bills WHERE id = ?").get(id) as { status: string }).status).toBe("paid");
    });
  });

  describe("resolveApprover", () => {
    const requestOf = (user: { id: string; name: string; role: "admin" | "cashier" }, ip = "10.0.0.1") =>
      ({ ip, user }) as unknown as FastifyRequest;
    const cashierReq = () => requestOf({ id: cashier.id, name: "Cara", role: "cashier" });
    const adminReq = () => requestOf({ id: admin.user.id, name: admin.user.name, role: "admin" });
    const status = async (p: Promise<unknown>) => p.then(() => 0, (e: { statusCode: number }) => e.statusCode);

    it("lets an admin approve themselves without a PIN", async () => {
      expect(await resolveApprover(app, adminReq())).toEqual({ id: admin.user.id, name: "Asha" });
    });

    it("requires a PIN from a cashier", async () => {
      const err = await resolveApprover(app, cashierReq()).catch((e: Error & { statusCode: number }) => e);
      expect(err).toMatchObject({ statusCode: 403, message: "Admin approval is required" });
    });

    it("rejects a wrong PIN, a non-admin PIN and an inactive admin's PIN", async () => {
      const second = await createUser(app, admin.token, { name: "Dev", pin: "3456", role: "admin" });
      app.db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(second.id);
      for (const pin of ["0000", "5678", "3456"]) {
        const err = await resolveApprover(app, cashierReq(), pin).catch((e: Error & { statusCode: number }) => e);
        expect(err, pin).toMatchObject({ statusCode: 401, message: "Admin PIN is incorrect" });
      }
    });

    it("returns the admin whose PIN was entered", async () => {
      expect(await resolveApprover(app, cashierReq(), "1234")).toEqual({ id: admin.user.id, name: "Asha" });
    });

    it("answers 429 once five wrong PINs are in, even for the right one", async () => {
      for (let i = 0; i < 5; i++) expect(await status(resolveApprover(app, cashierReq(), "0000"))).toBe(401);
      const err = await resolveApprover(app, cashierReq(), "1234").catch((e: Error & { statusCode: number }) => e);
      expect(err).toMatchObject({ statusCode: 429, message: "too many attempts" });
      // another address is unaffected
      expect(await resolveApprover(app, requestOf({ id: cashier.id, name: "Cara", role: "cashier" }, "10.0.0.2"), "1234")).toEqual({ id: admin.user.id, name: "Asha" });
    });

    it("keeps approval failures separate from login: a successful login does not lift the approval cooldown", async () => {
      const req = requestOf({ id: cashier.id, name: "Cara", role: "cashier" }, "127.0.0.1");
      for (let i = 0; i < 5; i++) expect(await status(resolveApprover(app, req, "0000"))).toBe(401);
      // the same address can still sign in (login has its own counter) and that sign-in clears only login failures
      const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "5678" } });
      expect(login.statusCode).toBe(200);
      expect(await status(resolveApprover(app, req, "1234"))).toBe(429);
    });

    it("does not let wrong approval PINs count against login, nor wrong login PINs against approval", async () => {
      const req = requestOf({ id: cashier.id, name: "Cara", role: "cashier" }, "127.0.0.1");
      for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/login", payload: { pin: "0000" } });
      expect((await app.inject({ method: "POST", url: "/api/login", payload: { pin: "5678" } })).statusCode).toBe(429);
      expect(await resolveApprover(app, req, "1234")).toEqual({ id: admin.user.id, name: "Asha" });
    });

    it("clears earlier wrong PINs once the right one is entered", async () => {
      for (let i = 0; i < 4; i++) await status(resolveApprover(app, cashierReq(), "0000"));
      await resolveApprover(app, cashierReq(), "1234");
      expect(await status(resolveApprover(app, cashierReq(), "0000"))).toBe(401);
      expect(app.approvalThrottle.pinCooldown("10.0.0.1")).toBe(false);
    });
  });

  describe("bill credit data", () => {
    it("shows no credit on a paid bill", async () => {
      const b = await bill();
      const res = await app.inject({ url: `/api/bills/${b.id}`, headers: auth(cashier.token) });
      expect(res.statusCode).toBe(200);
      const json = res.json().bill as Bill;
      expect(json.refundState).toBe("none");
      expect(json.creditNotes).toEqual([]);
      expect(json.refundedQty).toEqual({});
    });

    it("lists credit notes with their lines, refunds and people, and derives the refund state", async () => {
      const b = await bill();
      const orderItemId = (app.db.prepare("SELECT order_item_id AS id FROM bill_report_lines WHERE bill_id = ?").get(b.id) as { id: string }).id;
      const insert = (id: string, no: number, qty: number, t: [number, number, number, number, number], kind: string) => {
        app.db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, requested_by, approved_by, created_at, client_ref, request_json)
          VALUES (?, ?, ?, ?, 'Cold food', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`).run(id, no, b.id, kind, t[0], t[1], t[2], t[3], t[4], cashier.id, admin.user.id, 1000 + no, `ref-${no}-000000`);
        app.db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_id, category_name, gst_rate, qty, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise)
          VALUES (?, ?, 'Thali', ?, 'Food', 5, ?, ?, ?, ?, ?, ?)`).run(id, orderItemId, categoryId, qty, ...t);
        app.db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, 'cash', ?, 'note', ?)").run(uuidv7(), id, t[4], 1000 + no);
      };
      insert("cn-1", 1, 1, [3333, 83, 83, 0, 3499], "refund");
      let json = (await app.inject({ url: `/api/bills/${b.id}`, headers: auth(admin.token) })).json().bill as Bill;
      expect(json.refundState).toBe("partly_refunded");
      expect(json.refundedQty).toEqual({ [orderItemId]: 1 });
      expect(json.creditNotes).toEqual([{
        id: "cn-1", cnNo: 1, kind: "refund", reason: "Cold food", createdAt: 1001, totalPaise: 3499,
        taxablePaise: 3333, cgstPaise: 83, sgstPaise: 83, requestedByName: "Cara", approvedByName: "Asha",
        refunds: [{ mode: "cash", amountPaise: 3499, refNote: "note" }],
        lines: [{ orderItemId, name: "Thali", qty: 1, totalPaise: 3499 }],
      }]);

      insert("cn-2", 2, 2, [6666, 167, 167, 1, 7001], "void");
      json = (await app.inject({ url: `/api/bills/${b.id}`, headers: auth(admin.token) })).json().bill as Bill;
      expect(json.refundState).toBe("refunded");
      expect(json.refundedQty).toEqual({ [orderItemId]: 3 });
      expect(json.creditNotes.map((n) => n.cnNo)).toEqual([1, 2]);
    });

    it("loadBillCredit gathers lines, credited, paid and refunded", async () => {
      const b = await bill();
      const credit = loadBillCredit(app.db, b.id);
      expect(credit.lines).toHaveLength(1);
      expect(credit.lines[0]).toMatchObject({ qty: 3, name: "Thali", categoryName: "Food", gstRate: 5, taxablePaise: 9999, cgstPaise: 250, sgstPaise: 250, roundingPaise: 1, totalPaise: 10500 });
      expect(credit.lines[0]!.categoryId).toBe(categoryId);
      expect(credit.credited).toEqual({});
      expect(credit.paid).toEqual([{ mode: "cash", amountPaise: 10500 }]);
      expect(credit.refunded).toEqual([]);
      expect(credit.creditedTotalPaise).toBe(0);
    });
  });
});
