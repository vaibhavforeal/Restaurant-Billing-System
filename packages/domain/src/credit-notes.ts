import { z } from "zod";
import { PIN } from "./auth-schemas.js";

export type PayMode = "cash" | "upi" | "card";
const PAY_MODES: readonly PayMode[] = ["cash", "upi", "card"];

export type Money = { taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number };
/** A stored bill line (the whole line as billed, with any discount already allocated). */
export interface BillLine extends Money { orderItemId: string; qty: number; name: string; categoryId: string | null; categoryName: string; gstRate: number }
/** What earlier credit notes already took off one order item. */
export interface Credited extends Money { qty: number }
/** The lines of a draft carry the credited qty and money, not the billed ones. */
export interface CreditDraft {
  lines: Array<BillLine>;
  taxes: Array<{ gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }>;
  totals: Money;
}

const ALLOCATED_FIELDS = ["taxablePaise", "cgstPaise", "sgstPaise", "totalPaise"] as const;
const FIELDS = [...ALLOCATED_FIELDS, "roundingPaise"] as const;

export interface CreditHistoryViolation { orderItemId: string; invariant: string; field?: keyof Credited }

/** Existing financial records must be reviewed separately, never repaired by a negative new credit. */
export class CreditHistoryError extends Error {
  constructor(readonly violations: CreditHistoryViolation[]) {
    super("This bill's earlier refunds require review before another credit can be issued");
    this.name = "CreditHistoryError";
  }
}

/** Validate cumulative history against immutable originals, including lines already fully returned. */
export function validateCreditHistory(lines: readonly (Money & { orderItemId: string; qty: number })[], credited: Readonly<Record<string, Credited>>): void {
  const violations: CreditHistoryViolation[] = [];
  const byId = new Map(lines.map((line) => [line.orderItemId, line]));
  for (const orderItemId of Object.keys(credited)) {
    if (!byId.has(orderItemId)) violations.push({ orderItemId, invariant: "credit_line_not_on_bill" });
  }
  for (const line of lines) {
    const add = (invariant: string, field?: keyof Credited) => violations.push({ orderItemId: line.orderItemId, invariant, ...(field ? { field } : {}) });
    if (!Number.isSafeInteger(line.qty) || line.qty < 1) add("invalid_billed_quantity", "qty");
    for (const field of FIELDS) {
      if (!Number.isSafeInteger(line[field])) add("nonintegral_billed_amount", field);
      if (field !== "roundingPaise" && line[field] < 0) add("negative_billed_amount", field);
    }
    if (line.totalPaise !== line.taxablePaise + line.cgstPaise + line.sgstPaise + line.roundingPaise) add("billed_components_do_not_sum");
    const prior = credited[line.orderItemId];
    if (!prior) continue;
    if (!Number.isSafeInteger(prior.qty) || prior.qty < 0 || prior.qty > line.qty) add("credited_quantity_out_of_bounds", "qty");
    for (const field of FIELDS) {
      if (!Number.isSafeInteger(prior[field])) add("nonintegral_credited_amount", field);
      if (field !== "roundingPaise" && (prior[field] < 0 || prior[field] > line[field])) add("credited_amount_out_of_bounds", field);
      if (prior.qty === 0 && prior[field] !== 0) add("money_without_credited_quantity", field);
      if (prior.qty === line.qty && prior[field] !== line[field]) add("fully_credited_quantity_has_money_remaining", field);
    }
    if (prior.totalPaise !== prior.taxablePaise + prior.cgstPaise + prior.sgstPaise + prior.roundingPaise) add("credited_components_do_not_sum");
  }
  if (violations.length) throw new CreditHistoryError(violations);
}

/** round(value x q / n), half away from zero, in exact integer arithmetic. */
function proportion(value: number, q: number, n: number): number {
  const numerator = BigInt(value) * BigInt(q);
  const denominator = BigInt(n);
  const magnitude = ((numerator < 0n ? -numerator : numerator) * 2n + denominator) / (denominator * 2n);
  return Number(numerator < 0n ? -magnitude : magnitude);
}

function sumMoney(parts: readonly Money[]): Money {
  const out: Money = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 };
  for (const p of parts) {
    for (const f of FIELDS) out[f] += p[f];
  }
  return out;
}

function creditOne(line: BillLine, already: Credited | undefined, q: number): BillLine {
  const afterQty = (already?.qty ?? 0) + q;
  const credit: Money = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 };
  for (const field of ALLOCATED_FIELDS) {
    const previous = already?.[field] ?? 0;
    // Valid older credits may be ahead of the cumulative schedule; wait for it to catch up.
    const target = afterQty === line.qty ? line[field] : Math.max(previous, proportion(line[field], afterQty, line.qty));
    credit[field] = target - previous;
  }
  credit.roundingPaise = credit.totalPaise - credit.taxablePaise - credit.cgstPaise - credit.sgstPaise;
  return { ...line, qty: q, ...credit };
}

function groupTaxes(lines: readonly BillLine[]): CreditDraft["taxes"] {
  const byRate = new Map<number, CreditDraft["taxes"][number]>();
  for (const l of lines) {
    const t = byRate.get(l.gstRate) ?? { gstRate: l.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    t.taxablePaise += l.taxablePaise;
    t.cgstPaise += l.cgstPaise;
    t.sgstPaise += l.sgstPaise;
    byRate.set(l.gstRate, t);
  }
  return [...byRate.values()].sort((a, b) => a.gstRate - b.gstRate);
}

/** Cumulative credit for the requested quantities; the last units take the exact remainder of every amount. */
export function creditFor(
  lines: BillLine[],
  credited: Record<string, Credited>,
  requested: Array<{ orderItemId: string; qty: number }>,
): CreditDraft {
  validateCreditHistory(lines, credited);
  const wanted = new Map<string, number>();
  for (const r of requested) wanted.set(r.orderItemId, (wanted.get(r.orderItemId) ?? 0) + r.qty);
  const byId = new Map(lines.map((l) => [l.orderItemId, l]));
  const out: BillLine[] = [];
  for (const [orderItemId, q] of wanted) {
    const line = byId.get(orderItemId);
    if (!line) throw new Error(`Item ${orderItemId} is not on this bill`);
    if (!Number.isInteger(q) || q < 1) throw new Error(`Refund quantity for ${line.name} must be at least 1`);
    const left = line.qty - (credited[orderItemId]?.qty ?? 0);
    if (q > left) throw new Error(`Cannot refund ${q} of ${line.name}: only ${left} left on this bill`);
    out.push(creditOne(line, credited[orderItemId], q));
  }
  if (out.length === 0) throw new Error("Nothing left to refund on this bill");
  return { lines: out, taxes: groupTaxes(out), totals: sumMoney(out) };
}

/** Credit for every unit not yet credited. */
export function voidRemainder(lines: BillLine[], credited: Record<string, Credited>): CreditDraft {
  const remaining = lines
    .map((l) => ({ orderItemId: l.orderItemId, qty: l.qty - (credited[l.orderItemId]?.qty ?? 0) }))
    .filter((r) => r.qty > 0);
  return creditFor(lines, credited, remaining);
}

export function refundState(billTotalPaise: number, creditedTotalPaise: number): "none" | "partly_refunded" | "refunded" {
  if (creditedTotalPaise <= 0) return "none";
  return creditedTotalPaise >= billTotalPaise ? "refunded" : "partly_refunded";
}

/** Money still held per payment method: paid minus already refunded. */
export function refundableByMode(
  paid: Array<{ mode: PayMode; amountPaise: number }>,
  refunded: Array<{ mode: PayMode; amountPaise: number }>,
): Record<PayMode, number> {
  const out: Record<PayMode, number> = { cash: 0, upi: 0, card: 0 };
  for (const p of paid) out[p.mode] += p.amountPaise;
  for (const r of refunded) out[r.mode] -= r.amountPaise;
  for (const m of PAY_MODES) out[m] = Math.max(0, out[m]);
  return out;
}

const Ref = z.string().min(8).max(64);
const CreditLines = z.array(z.strictObject({ orderItemId: z.string().min(1), qty: z.number().int().min(1) }));

export const CreditPreview = z.strictObject({
  kind: z.enum(["void", "refund"]),
  lines: CreditLines.optional(),
});
export const VoidBill = z.strictObject({
  clientRef: Ref,
  reason: z.string().trim().min(1).max(200),
  refunds: z.array(z.strictObject({
    mode: z.enum(["cash", "upi", "card"]),
    amountPaise: z.number().int().min(1),
    refNote: z.string().max(100).optional(),
  })).default([]),
  approverPin: PIN.optional(),
});
export const RefundBill = VoidBill.safeExtend({ lines: CreditLines.min(1) });
export type CreditPreviewInput = z.infer<typeof CreditPreview>;
export type VoidBillInput = z.infer<typeof VoidBill>;
export type RefundBillInput = z.infer<typeof RefundBill>;
