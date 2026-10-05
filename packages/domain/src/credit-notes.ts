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

type Field = "taxablePaise" | "cgstPaise" | "sgstPaise" | "roundingPaise";
const FIELDS: readonly Field[] = ["taxablePaise", "cgstPaise", "sgstPaise", "roundingPaise"];

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
    out.totalPaise += p.totalPaise;
  }
  return out;
}

function creditOne(line: BillLine, already: Credited | undefined, q: number): BillLine {
  const lastUnits = (already?.qty ?? 0) + q === line.qty;
  const credit: Record<Field, number> = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0 };
  for (const f of FIELDS) credit[f] = lastUnits ? line[f] - (already?.[f] ?? 0) : proportion(line[f], q, line.qty);
  const totalPaise = credit.taxablePaise + credit.cgstPaise + credit.sgstPaise + credit.roundingPaise;
  return { ...line, qty: q, ...credit, totalPaise };
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

/** Credit for the requested quantities; the last units of a line take the exact remainder so a bill's credits always sum to the bill. */
export function creditFor(
  lines: BillLine[],
  credited: Record<string, Credited>,
  requested: Array<{ orderItemId: string; qty: number }>,
): CreditDraft {
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
