import { z } from "zod";
import { PIN } from "./auth-schemas.js";
import type { ChargeKind } from "./billing.js";

export type PayMode = "cash" | "upi" | "card";
const PAY_MODES: readonly PayMode[] = ["cash", "upi", "card"];

export type Money = { taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number };
/** A stored bill line (the whole line as billed, with any discount already allocated); `packagingPaise` is its per-item packaging. */
export interface BillLine extends Money { orderItemId: string; qty: number; name: string; categoryId: string | null; categoryName: string; gstRate: number; packagingPaise: number }
/** What earlier credit notes already took off one order item. */
export interface Credited extends Money { qty: number }
/**
 * A service or packaging charge. On a bill `amountPaise` is the billed charge amount; in a draft, the amount this note credits.
 * Its rounding is 0 unless every item was discounted to nothing.
 */
export interface BillChargeCredit extends Money { kind: ChargeKind; label: string; gstRate: number; percentBp?: number; amountPaise: number }
/** What earlier credit notes already took off each charge kind. */
export type CreditedCharges = Partial<Record<ChargeKind, Money & { amountPaise: number }>>;
/** The lines of a draft carry the credited qty and money, not the billed ones. */
export interface CreditDraft {
  lines: Array<BillLine>;
  /** Charges credited by this note, each with the amount it credits. */
  charges: BillChargeCredit[];
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

function groupTaxes(lines: ReadonlyArray<Pick<BillLine, "gstRate" | "taxablePaise" | "cgstPaise" | "sgstPaise">>): CreditDraft["taxes"] {
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

function wantedQty(requested: Array<{ orderItemId: string; qty: number }>): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const r of requested) wanted.set(r.orderItemId, (wanted.get(r.orderItemId) ?? 0) + r.qty);
  return wanted;
}

function clearsBill(lines: BillLine[], credited: Record<string, Credited>, wanted: Map<string, number>): boolean {
  return lines.every((l) => (credited[l.orderItemId]?.qty ?? 0) + (wanted.get(l.orderItemId) ?? 0) === l.qty);
}

function uncredited(charge: BillChargeCredit, creditedCharges: CreditedCharges): number {
  return Math.max(0, charge.amountPaise - (creditedCharges[charge.kind]?.amountPaise ?? 0));
}

/** Credit `amount` of a charge; the credit that clears what is left takes the exact remainder of each field. */
function creditCharge(charge: BillChargeCredit, creditedCharges: CreditedCharges, amount: number): BillChargeCredit {
  const already = creditedCharges[charge.kind];
  const last = amount === uncredited(charge, creditedCharges);
  const credit: Record<Field, number> = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0 };
  for (const f of FIELDS) credit[f] = last ? charge[f] - (already?.[f] ?? 0) : proportion(charge[f], amount, charge.amountPaise);
  const totalPaise = credit.taxablePaise + credit.cgstPaise + credit.sgstPaise + credit.roundingPaise;
  return { ...charge, ...credit, totalPaise, amountPaise: amount };
}

/** The packaging amount a refund of `requested` credits when "Refund packaging" is ticked, capped at what is still uncredited. */
export function packagingCredit(
  lines: BillLine[],
  credited: Record<string, Credited>,
  requested: Array<{ orderItemId: string; qty: number }>,
  charges: BillChargeCredit[],
  creditedCharges: CreditedCharges,
): number {
  const charge = charges.find((c) => c.kind === "packaging");
  if (!charge) return 0;
  const wanted = wantedQty(requested);
  let amount = 0;
  for (const l of lines) {
    const q = wanted.get(l.orderItemId) ?? 0;
    if (q <= 0 || l.packagingPaise <= 0) continue;
    const before = credited[l.orderItemId]?.qty ?? 0;
    amount += proportion(l.packagingPaise, before + q, l.qty) - proportion(l.packagingPaise, before, l.qty);
  }
  if (clearsBill(lines, credited, wanted)) amount += Math.max(0, charge.amountPaise - lines.reduce((sum, l) => sum + l.packagingPaise, 0));
  return Math.max(0, Math.min(amount, uncredited(charge, creditedCharges)));
}

function draftOf(lines: BillLine[], charges: BillChargeCredit[]): CreditDraft {
  if (lines.length === 0 && charges.length === 0) throw new Error("Nothing left to refund on this bill");
  return { lines, charges, taxes: groupTaxes([...lines, ...charges]), totals: sumMoney([...lines, ...charges]) };
}

/**
 * Credit for the requested quantities; the last units of a line take the exact remainder so a bill's credits always sum to the bill.
 * Packaging: the refunded items' packaging, plus the flat part when the refund clears the bill — none when `refundPackaging` is false.
 * Service charge: what is left of it, only when the refund clears every remaining item.
 */
export function creditFor(
  lines: BillLine[],
  credited: Record<string, Credited>,
  requested: Array<{ orderItemId: string; qty: number }>,
  charges: BillChargeCredit[] = [],
  creditedCharges: CreditedCharges = {},
  opts: { refundPackaging?: boolean } = {},
): CreditDraft {
  const wanted = wantedQty(requested);
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
  // A refund always credits items; packaging kept by earlier refunds is only taken back by a void.
  if (out.length === 0) throw new Error("Nothing left to refund on this bill");
  const clears = clearsBill(lines, credited, wanted);
  const refundPackaging = opts.refundPackaging ?? true;
  const chargeCredits: BillChargeCredit[] = [];
  for (const c of charges) {
    const amount = c.kind === "packaging"
      ? (refundPackaging ? packagingCredit(lines, credited, requested, charges, creditedCharges) : 0)
      : (clears ? uncredited(c, creditedCharges) : 0);
    if (amount > 0) chargeCredits.push(creditCharge(c, creditedCharges, amount));
  }
  return draftOf(out, chargeCredits);
}

/** Credit for every unit not yet credited, plus what is left of every charge (including packaging kept by earlier refunds). */
export function voidRemainder(lines: BillLine[], credited: Record<string, Credited>, charges: BillChargeCredit[] = [], creditedCharges: CreditedCharges = {}): CreditDraft {
  const out = lines
    .map((l) => ({ line: l, q: l.qty - (credited[l.orderItemId]?.qty ?? 0) }))
    .filter((r) => r.q > 0)
    .map((r) => creditOne(r.line, credited[r.line.orderItemId], r.q));
  const chargeCredits = charges
    .map((c) => ({ c, amount: uncredited(c, creditedCharges) }))
    .filter((x) => x.amount > 0)
    .map((x) => creditCharge(x.c, creditedCharges, x.amount));
  return draftOf(out, chargeCredits);
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
  /** Credit the refunded items' packaging (ticked by default); ignored by a void. */
  refundPackaging: z.boolean().default(true),
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
export const RefundBill = VoidBill.safeExtend({ lines: CreditLines.min(1), refundPackaging: z.boolean().default(true) });
export type CreditPreviewInput = z.infer<typeof CreditPreview>;
export type VoidBillInput = z.infer<typeof VoidBill>;
export type RefundBillInput = z.infer<typeof RefundBill>;
