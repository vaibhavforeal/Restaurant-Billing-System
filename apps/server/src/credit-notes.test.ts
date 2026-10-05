import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { uuidv7, type Bill } from "@forkflow/domain";
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

  /** An order of `qty` thalis, billed and optionally settled in cash (3 x 3333 -> 10500 with 1 paise of rounding). */
  async function bill(qty = 3, settle = true): Promise<Bill> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    const add = await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(admin.token), payload: { items: [{ productId, qty, clientRef: uuidv7() }] } });
    expect(add.statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill-preview`, headers: auth(admin.token), payload: {} });
    const issued = await app.inject({ method: "POST", url: `/api/orders/${orderId}/bill`, headers: auth(admin.token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey } });
    expect(issued.statusCode).toBe(201);
    const issuedBill = issued.json().bill as Bill;
    if (!settle) return issuedBill;
    const paid = await app.inject({ method: "POST", url: `/api/bills/${issuedBill.id}/settle`, headers: auth(admin.token), payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: issuedBill.totalPaise }] } });
    expect(paid.statusCode).toBe(200);
    return paid.json().bill as Bill;
  }
  const preview = (billId: string, payload: unknown, token = cashier.token) =>
    app.inject({ method: "POST", url: `/api/bills/${billId}/credit-preview`, headers: auth(token), payload: payload as object });

  /** A bill issued before report lines existed: a bills row with taxes and a payment but no bill_report_lines. */
  async function olderBill(): Promise<string> {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = created.json().order.id as string;
    const id = uuidv7();
    app.db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_at, created_by)
      VALUES (?, 900, ?, 10000, 0, 250, 250, 0, 10500, 'paid', ?, ?)`).run(id, orderId, Date.now(), admin.user.id);
    app.db.prepare("INSERT INTO bill_taxes (id, bill_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, ?, 5, 10000, 250, 250)").run(uuidv7(), id);
    app.db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, created_at) VALUES (?, ?, 'upi', 10500, ?)").run(uuidv7(), id, Date.now());
    return id;
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

    it("counts wrong approval PINs against the login throttle for the same address", async () => {
      const req = requestOf({ id: cashier.id, name: "Cara", role: "cashier" }, "127.0.0.1");
      for (let i = 0; i < 5; i++) expect(await status(resolveApprover(app, req, "0000"))).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "5678" } });
      expect(login.statusCode).toBe(429);
    });

    it("clears earlier wrong PINs once the right one is entered", async () => {
      for (let i = 0; i < 4; i++) await status(resolveApprover(app, cashierReq(), "0000"));
      await resolveApprover(app, cashierReq(), "1234");
      expect(await status(resolveApprover(app, cashierReq(), "0000"))).toBe(401);
      expect(app.pinThrottle.pinCooldown("10.0.0.1")).toBe(false);
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
