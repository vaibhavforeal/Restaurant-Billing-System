import { verifyPassword } from "@forkflow/core";
import { BillPrint, CreditPreview, RefundBill, VoidBill, creditFor, nextSequence, refundState, refundableByMode, uuidv7, voidRemainder,
  type Bill, type BillCreditNote, type BillLine, type CreditDraft, type Credited, type Database, type Money, type PayMode, type RefundBillInput, type VoidBillInput } from "@forkflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadBill } from "./billing.js";
import { httpError } from "./http-error.js";
import { loadOrderJson } from "./mappers.js";
import { creditNoteHtml, creditNoteSlip, type CreditNoteView } from "./print/credit-note.js";
import { readProfile } from "./print/profile.js";

interface MoneyRow { taxable_paise: number; cgst_paise: number; sgst_paise: number; rounding_paise: number; total_paise: number }
const money = (r: MoneyRow): Money => ({ taxablePaise: r.taxable_paise, cgstPaise: r.cgst_paise, sgstPaise: r.sgst_paise, roundingPaise: r.rounding_paise, totalPaise: r.total_paise });

export interface BillCredit {
  lines: BillLine[];
  /** Units and money already taken off each order item by earlier credit notes. */
  credited: Record<string, Credited>;
  paid: Array<{ mode: PayMode; amountPaise: number }>;
  refunded: Array<{ mode: PayMode; amountPaise: number }>;
  creditedTotalPaise: number;
}

/** Everything the credit math needs for one bill, read from the stored (immutable) lines and credit notes. */
export function loadBillCredit(db: Database, billId: string): BillCredit {
  const lines = (db.prepare(`SELECT l.order_item_id, l.qty, l.name, l.category_id, l.category_name, oi.gst_rate_snapshot AS gst_rate,
      l.taxable_paise, l.cgst_paise, l.sgst_paise, l.rounding_paise, l.total_paise
    FROM bill_report_lines l JOIN order_items oi ON oi.id = l.order_item_id
    WHERE l.bill_id = ? ORDER BY l.order_item_id`).all(billId) as Array<MoneyRow & {
      order_item_id: string; qty: number; name: string; category_id: string | null; category_name: string; gst_rate: number;
    }>).map((r): BillLine => ({ orderItemId: r.order_item_id, qty: r.qty, name: r.name, categoryId: r.category_id,
      categoryName: r.category_name, gstRate: r.gst_rate, ...money(r) }));

  const credited: Record<string, Credited> = {};
  const creditedRows = db.prepare(`SELECT cl.order_item_id, SUM(cl.qty) AS qty, SUM(cl.taxable_paise) AS taxable_paise, SUM(cl.cgst_paise) AS cgst_paise,
      SUM(cl.sgst_paise) AS sgst_paise, SUM(cl.rounding_paise) AS rounding_paise, SUM(cl.total_paise) AS total_paise
    FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
    WHERE c.bill_id = ? GROUP BY cl.order_item_id`).all(billId) as Array<MoneyRow & { order_item_id: string; qty: number }>;
  for (const r of creditedRows) credited[r.order_item_id] = { qty: r.qty, ...money(r) };

  const paid = db.prepare("SELECT mode, amount_paise AS amountPaise FROM payments WHERE bill_id = ? ORDER BY id").all(billId) as BillCredit["paid"];
  const refunded = db.prepare(`SELECT rp.mode, rp.amount_paise AS amountPaise FROM refund_payments rp
    JOIN credit_notes c ON c.id = rp.credit_note_id WHERE c.bill_id = ? ORDER BY rp.id`).all(billId) as BillCredit["refunded"];
  const { total } = db.prepare("SELECT COALESCE(SUM(total_paise), 0) AS total FROM credit_notes WHERE bill_id = ?").get(billId) as { total: number };
  return { lines, credited, paid, refunded, creditedTotalPaise: total };
}

/** The credit-note part of a bill's JSON: its notes, the derived refund state and the units credited per item. */
export function loadBillCreditNotes(db: Database, billId: string, billTotalPaise: number): {
  refundState: ReturnType<typeof refundState>; creditNotes: BillCreditNote[]; refundedQty: Record<string, number>;
} {
  const notes = db.prepare(`SELECT c.id, c.cn_no AS cnNo, c.kind, c.reason, c.created_at AS createdAt, c.total_paise AS totalPaise,
      c.taxable_paise AS taxablePaise, c.cgst_paise AS cgstPaise, c.sgst_paise AS sgstPaise,
      rb.name AS requestedByName, ab.name AS approvedByName
    FROM credit_notes c JOIN users rb ON rb.id = c.requested_by JOIN users ab ON ab.id = c.approved_by
    WHERE c.bill_id = ? ORDER BY c.cn_no`).all(billId) as Array<Omit<BillCreditNote, "refunds" | "lines">>;
  const refunds = db.prepare(`SELECT rp.credit_note_id AS noteId, rp.mode, rp.amount_paise AS amountPaise, rp.ref_note AS refNote
    FROM refund_payments rp JOIN credit_notes c ON c.id = rp.credit_note_id WHERE c.bill_id = ? ORDER BY rp.id`).all(billId) as Array<BillCreditNote["refunds"][number] & { noteId: string }>;
  const lines = db.prepare(`SELECT cl.credit_note_id AS noteId, cl.order_item_id AS orderItemId, cl.name, cl.qty, cl.total_paise AS totalPaise
    FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id WHERE c.bill_id = ? ORDER BY cl.rowid`).all(billId) as Array<BillCreditNote["lines"][number] & { noteId: string }>;

  const refundedQty: Record<string, number> = {};
  for (const l of lines) refundedQty[l.orderItemId] = (refundedQty[l.orderItemId] ?? 0) + l.qty;
  const creditNotes = notes.map((n): BillCreditNote => ({
    ...n,
    refunds: refunds.filter((r) => r.noteId === n.id).map(({ mode, amountPaise, refNote }) => ({ mode, amountPaise, refNote })),
    lines: lines.filter((l) => l.noteId === n.id).map(({ orderItemId, name, qty, totalPaise }) => ({ orderItemId, name, qty, totalPaise })),
  }));
  return { refundState: refundState(billTotalPaise, creditNotes.reduce((sum, n) => sum + n.totalPaise, 0)), creditNotes, refundedQty };
}

/** Money still held per payment method and in total (paid minus refunded; the total is not clamped per method). */
export function refundableOf(credit: BillCredit): Record<PayMode, number> & { total: number } {
  const sum = (rows: Array<{ amountPaise: number }>) => rows.reduce((s, r) => s + r.amountPaise, 0);
  return { ...refundableByMode(credit.paid, credit.refunded), total: sum(credit.paid) - sum(credit.refunded) };
}

interface CreditBillRow { id: string; order_id: string; status: "unpaid" | "paid" | "void"; total_paise: number }

/**
 * The credit a void or refund of this bill would issue, or the HTTP error that stops it. Shared by the preview and the
 * writes so both apply identical rules. A bill with no stored lines can only be voided: its credit is the bill totals.
 */
export function draftCredit(db: Database, billId: string, kind: "void" | "refund", requested: Array<{ orderItemId: string; qty: number }> = []): { bill: CreditBillRow; credit: BillCredit; draft: CreditDraft } {
  const bill = db.prepare("SELECT id, order_id, status, total_paise FROM bills WHERE id = ?").get(billId) as CreditBillRow | undefined;
  if (!bill) throw httpError(404, "bill not found");
  if (bill.status === "void") throw httpError(409, kind === "void" ? "This bill is already void" : "Nothing left to refund on this bill");
  const credit = loadBillCredit(db, billId);
  if (kind === "refund") {
    if (bill.status !== "paid") throw httpError(409, "Only paid bills can be refunded");
    if (credit.lines.length === 0) throw httpError(409, "This older bill can only be voided");
    if (credit.lines.every((l) => (credit.credited[l.orderItemId]?.qty ?? 0) >= l.qty)) throw httpError(409, "Nothing left to refund on this bill");
    if (requested.length === 0) throw httpError(400, "Choose the items to refund");
  }
  if (credit.lines.length === 0) {
    // Older bills can only be voided (refunds are refused above and a void ends the bill), so no earlier credit exists:
    // the credit is the whole bill. Taxable comes from the per-rate taxes so the totals match them exactly.
    const taxes = db.prepare("SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ? ORDER BY gst_rate").all(billId) as CreditDraft["taxes"];
    const sum = (f: "taxablePaise" | "cgstPaise" | "sgstPaise") => taxes.reduce((s, t) => s + t[f], 0);
    const taxablePaise = sum("taxablePaise"), cgstPaise = sum("cgstPaise"), sgstPaise = sum("sgstPaise");
    const totals: Money = { taxablePaise, cgstPaise, sgstPaise, roundingPaise: bill.total_paise - taxablePaise - cgstPaise - sgstPaise, totalPaise: bill.total_paise };
    return { bill, credit, draft: { lines: [], taxes, totals } };
  }
  try {
    return { bill, credit, draft: kind === "void" ? voidRemainder(credit.lines, credit.credited) : creditFor(credit.lines, credit.credited, requested) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid credit";
    throw httpError(message === "Nothing left to refund on this bill" ? 409 : 400, message);
  }
}

/** The signed-in admin for an admin requester; otherwise the active admin whose PIN was entered, counted by the approval throttle (separate from login's). */
export async function resolveApprover(app: FastifyInstance, req: FastifyRequest, approverPin?: string): Promise<{ id: string; name: string }> {
  if (req.user.role === "admin") return { id: req.user.id, name: req.user.name };
  if (!approverPin) throw httpError(403, "Admin approval is required");
  const throttle = app.approvalThrottle;
  if (throttle.pinCooldown(req.ip)) throw httpError(429, "too many attempts");
  const admins = app.db.prepare("SELECT id, name, pin_hash FROM users WHERE role = 'admin' AND is_active = 1").all() as Array<{ id: string; name: string; pin_hash: string }>;
  for (const admin of admins) {
    if (await verifyPassword(approverPin, admin.pin_hash)) {
      throttle.clearPinFailures(req.ip);
      return { id: admin.id, name: admin.name };
    }
  }
  throttle.recordPinFailure(req.ip);
  throw httpError(401, "Admin PIN is incorrect");
}

type RefundInput = VoidBillInput["refunds"];

/** Refunds must stay within what each method paid, less what it already refunded. */
export function checkRefundMethods(credit: BillCredit, refunds: RefundInput): void {
  const held = refundableOf(credit);
  const asked: Record<PayMode, number> = { cash: 0, upi: 0, card: 0 };
  for (const r of refunds) asked[r.mode] += r.amountPaise;
  for (const mode of ["cash", "upi", "card"] as const) {
    if (asked[mode] > held[mode]) throw httpError(400, `Refund by ${mode} cannot exceed what was paid by ${mode}`);
  }
}

/** A void's refunds: none on an unpaid bill; on a paid bill exactly the money still held (paid − already refunded). */
function checkVoidRefunds(bill: CreditBillRow, credit: BillCredit, refunds: RefundInput): void {
  if (bill.status === "unpaid") {
    if (refunds.length > 0) throw httpError(400, "An unpaid bill has no payments to refund");
    return;
  }
  const held = refundableOf(credit).total;
  const asked = refunds.reduce((s, r) => s + r.amountPaise, 0);
  // Money held only shrinks (other refunds) and a bill only goes unpaid -> paid, so asking for more than is held, or
  // refunding nothing on a paid bill that still holds money, means the bill changed after the counter reviewed it.
  if (asked > held || (refunds.length === 0 && held > 0)) throw httpError(409, "This bill changed — review again");
  if (asked !== held) throw httpError(400, "Refund amounts must equal the credit note total");
  checkRefundMethods(credit, refunds);
}

/** A refund's methods must add up to the credit note total and stay within what each method still holds. */
function checkRefundAmounts(credit: BillCredit, draft: CreditDraft, refunds: RefundInput): void {
  if (refunds.reduce((s, r) => s + r.amountPaise, 0) !== draft.totals.totalPaise) throw httpError(400, "Refund amounts must equal the credit note total");
  checkRefundMethods(credit, refunds);
}

/** Append a credit note with its lines, per-rate taxes and refund payments; returns its id. Call inside the write transaction. */
export function writeCreditNote(db: Database, note: {
  billId: string; kind: "void" | "refund"; reason: string; draft: CreditDraft; refunds: RefundInput;
  requestedBy: string; approvedBy: string; clientRef: string; requestJson: string; now: number;
}): string {
  const id = uuidv7();
  const t = note.draft.totals;
  db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise,
      requested_by, approved_by, created_at, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, nextSequence(db, "credit_note_no"), note.billId, note.kind, note.reason, t.taxablePaise, t.cgstPaise, t.sgstPaise, t.roundingPaise, t.totalPaise,
      note.requestedBy, note.approvedBy, note.now, note.clientRef, note.requestJson);
  const line = db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_id, category_name, gst_rate, qty,
      taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of note.draft.lines) {
    line.run(id, l.orderItemId, l.name, l.categoryId, l.categoryName, l.gstRate, l.qty, l.taxablePaise, l.cgstPaise, l.sgstPaise, l.roundingPaise, l.totalPaise);
  }
  const tax = db.prepare("INSERT INTO credit_note_taxes (credit_note_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?)");
  for (const x of note.draft.taxes) tax.run(id, x.gstRate, x.taxablePaise, x.cgstPaise, x.sgstPaise);
  const refund = db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of note.refunds) refund.run(uuidv7(), id, r.mode, r.amountPaise, r.refNote || null, note.now);
  return id;
}

/** The earlier credit note written for this reference, if any; a reference reused with a different request is refused. */
export function replayedCreditNote(db: Database, clientRef: string, requestJson: string): { id: string; billId: string } | null {
  const row = db.prepare("SELECT id, bill_id AS billId, request_json AS requestJson FROM credit_notes WHERE client_ref = ?").get(clientRef) as { id: string; billId: string; requestJson: string } | undefined;
  if (!row) return null;
  if (row.requestJson !== requestJson) throw httpError(409, "Credit note reference already used for a different request");
  return { id: row.id, billId: row.billId };
}

/** The bill (with its credit notes) and the one credit note a write produced. */
function billWithNote(db: Database, billId: string, noteId: string): { bill: Bill; creditNote: BillCreditNote } {
  const bill = loadBill(db, billId);
  return { bill, creditNote: bill.creditNotes.find((n) => n.id === noteId)! };
}

interface IssueCredit {
  kind: "void" | "refund";
  billId: string;
  request: { clientRef: string; reason: string; refunds: RefundInput };
  approverPin?: string | undefined;
  /** Items asked for (refund only). */
  lines?: RefundBillInput["lines"];
}

/**
 * A void or refund: replay check, approval, then one transaction that re-drafts the credit from the stored bill, applies the
 * kind's rules and writes the credit note. Responds with the bill, the credit note and the order; broadcasts only when new.
 */
async function issueCredit(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, input: IssueCredit): Promise<unknown> {
  const db = app.db;
  const { kind, billId: id, request } = input;
  // The retry fingerprint never holds the PIN: a retry is identical when the bill, kind, reason, items and refunds are.
  const requestJson = JSON.stringify({ billId: id, kind, ...request, ...(input.lines ? { lines: input.lines } : {}) });
  const earlier = replayedCreditNote(db, request.clientRef, requestJson);
  if (earlier) {
    const replayed = billWithNote(db, earlier.billId, earlier.id);
    return reply.status(200).send({ ...replayed, order: loadOrderJson(db, replayed.bill.orderId) });
  }
  const approver = await resolveApprover(app, req, input.approverPin);

  const result = db.transaction(() => {
    // Another request may have written this reference, voided or refunded the bill while the PIN was checked.
    const replay = replayedCreditNote(db, request.clientRef, requestJson);
    if (replay) return { created: false, ...billWithNote(db, replay.billId, replay.id), tables: [] as string[] };
    const { bill, credit, draft } = draftForWrite(db, id, kind, input.lines);
    if (kind === "void") checkVoidRefunds(bill, credit, request.refunds);
    else checkRefundAmounts(credit, draft, request.refunds);
    // Read before the order closes: cancelling deactivates its table links.
    const own = db.prepare("SELECT table_id FROM orders WHERE id = ?").get(bill.order_id) as { table_id: string | null } | undefined;
    const linked = (db.prepare(`SELECT tl.table_id FROM table_links tl JOIN orders o ON o.id = tl.order_id
      WHERE tl.order_id = ? AND o.status IN ('open', 'billed') ORDER BY tl.linked_at, tl.id`).all(bill.order_id) as Array<{ table_id: string }>).map((r) => r.table_id);
    const now = Date.now();
    const noteId = writeCreditNote(db, { billId: id, kind, reason: request.reason, draft, refunds: request.refunds,
      requestedBy: req.user.id, approvedBy: approver.id, clientRef: request.clientRef, requestJson, now });
    if (kind === "void") {
      db.prepare("UPDATE bills SET status = 'void' WHERE id = ?").run(id);
      if (bill.status === "unpaid") {
        db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(now, req.user.id, request.reason, bill.order_id);
      }
    }
    const tables = [...new Set([...(own?.table_id ? [own.table_id] : []), ...linked])];
    // The response bill is built inside the transaction so a bill that cannot be shown (no saved receipt) rolls the write back.
    return { created: true, ...billWithNote(db, id, noteId), tables };
  })();

  const order = loadOrderJson(db, result.bill.orderId)!;
  if (result.created) {
    app.broadcast("order.updated", { order });
    for (const tableId of result.tables) app.broadcast("table.changed", { tableId });
  }
  return reply.status(result.created ? 201 : 200).send({ bill: result.bill, creditNote: result.creditNote, order });
}

/**
 * draftCredit for a write. The counter reviewed an earlier preview, so a refund quantity that no longer fits an item on the
 * bill means the bill changed since (409); items that were never on the bill stay a bad request.
 */
function draftForWrite(db: Database, billId: string, kind: "void" | "refund", lines?: RefundBillInput["lines"]): ReturnType<typeof draftCredit> {
  try {
    return draftCredit(db, billId, kind, lines);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 400 || !lines) throw err;
    const credit = loadBillCredit(db, billId);
    const wanted = new Map<string, number>();
    for (const l of lines) wanted.set(l.orderItemId, (wanted.get(l.orderItemId) ?? 0) + l.qty);
    const outgrown = credit.lines.some((l) => (wanted.get(l.orderItemId) ?? 0) > l.qty - (credit.credited[l.orderItemId]?.qty ?? 0));
    throw outgrown ? httpError(409, "This bill changed — review again") : err;
  }
}

/** A credit note with its per-rate taxes (not part of the bill JSON) and the bill it was issued against. */
function loadCreditNote(db: Database, id: string): { note: CreditNoteView; bill: Bill } {
  const row = db.prepare("SELECT bill_id AS billId FROM credit_notes WHERE id = ?").get(id) as { billId: string } | undefined;
  if (!row) throw httpError(404, "credit note not found");
  const bill = loadBill(db, row.billId);
  const found = bill.creditNotes.find((n) => n.id === id)!;
  const taxes = db.prepare("SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM credit_note_taxes WHERE credit_note_id = ? ORDER BY gst_rate").all(id) as CreditNoteView["taxes"];
  return { note: { ...found, taxes }, bill };
}

export function registerCreditNotes(app: FastifyInstance): void {
  const db = app.db;
  const refundPermission = app.requirePermission("bills.refund");

  app.get("/api/credit-notes/:id/receipt", { preHandler: app.requirePermission("bills.read") }, async (req, reply) => {
    const { note, bill } = loadCreditNote(db, (req.params as { id: string }).id);
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    return reply.type("text/html; charset=utf-8").send(creditNoteHtml(note, bill));
  });

  app.post("/api/credit-notes/:id/print", { preHandler: app.requirePermission("bills.print") }, async (req, reply) => {
    const { note, bill } = loadCreditNote(db, (req.params as { id: string }).id);
    const body = BillPrint.parse(req.body);
    const p = db.prepare("SELECT * FROM printers WHERE id = ? AND is_active = 1").get(body.printerId) as
      { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paper_width: 58 | 80; receipt_profile: string } | undefined;
    if (!p) throw httpError(400, "Choose an active receipt printer");
    const profile = readProfile(p.receipt_profile);
    const job = app.printQueue.enqueue(p, "credit_note", `CN-${note.cnNo}`, creditNoteSlip(note, bill, p.paper_width, profile), profile.copies);
    return reply.status(202).send({ job });
  });

  app.post("/api/bills/:id/credit-preview", { preHandler: refundPermission }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CreditPreview.parse(req.body ?? {});
    const { credit, draft } = draftCredit(db, id, body.kind, body.lines ?? []);
    return { preview: { lines: draft.lines, taxes: draft.taxes, totals: draft.totals, refundable: refundableOf(credit) } };
  });

  app.post("/api/bills/:id/void", { preHandler: refundPermission }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { approverPin, ...request } = VoidBill.parse(req.body ?? {});
    return issueCredit(app, req, reply, { kind: "void", billId: id, request, approverPin });
  });

  app.post("/api/bills/:id/refund", { preHandler: refundPermission }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { approverPin, lines, ...request } = RefundBill.parse(req.body ?? {});
    return issueCredit(app, req, reply, { kind: "refund", billId: id, request, approverPin, lines });
  });
}
