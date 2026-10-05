import { verifyPassword } from "@forkflow/core";
import { CreditPreview, creditFor, refundState, refundableByMode, voidRemainder,
  type BillCreditNote, type BillLine, type CreditDraft, type Credited, type Database, type Money, type PayMode } from "@forkflow/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpError } from "./http-error.js";

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

interface CreditBillRow { id: string; status: "unpaid" | "paid" | "void"; total_paise: number; cgst_paise: number; sgst_paise: number; rounding_paise: number }

/**
 * The credit a void or refund of this bill would issue, or the HTTP error that stops it. Shared by the preview and the
 * writes so both apply identical rules. A bill with no stored lines can only be voided: its credit is the bill totals.
 */
export function draftCredit(db: Database, billId: string, kind: "void" | "refund", requested: Array<{ orderItemId: string; qty: number }> = []): { bill: CreditBillRow; credit: BillCredit; draft: CreditDraft } {
  const bill = db.prepare("SELECT id, status, total_paise, cgst_paise, sgst_paise, rounding_paise FROM bills WHERE id = ?").get(billId) as CreditBillRow | undefined;
  if (!bill) throw httpError(404, "bill not found");
  if (bill.status === "void") throw httpError(409, "Nothing left to refund on this bill");
  const credit = loadBillCredit(db, billId);
  if (kind === "refund") {
    if (bill.status !== "paid") throw httpError(409, "Only paid bills can be refunded");
    if (credit.lines.length === 0) throw httpError(409, "This older bill can only be voided");
    if (requested.length === 0) throw httpError(400, "Choose the items to refund");
  }
  if (credit.lines.length === 0) {
    const taxes = db.prepare("SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ? ORDER BY gst_rate").all(billId) as CreditDraft["taxes"];
    const totals: Money = { taxablePaise: bill.total_paise - bill.cgst_paise - bill.sgst_paise - bill.rounding_paise, cgstPaise: bill.cgst_paise,
      sgstPaise: bill.sgst_paise, roundingPaise: bill.rounding_paise, totalPaise: bill.total_paise };
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

export function registerCreditNotes(app: FastifyInstance): void {
  const db = app.db;
  const refundPermission = app.requirePermission("bills.refund");

  app.post("/api/bills/:id/credit-preview", { preHandler: refundPermission }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CreditPreview.parse(req.body ?? {});
    const { credit, draft } = draftCredit(db, id, body.kind, body.lines ?? []);
    return { preview: { lines: draft.lines, taxes: draft.taxes, totals: draft.totals, refundable: refundableOf(credit) } };
  });
}
