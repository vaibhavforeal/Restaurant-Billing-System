import type { PayMode, PaymentMode } from "@forkflow/domain";

export type { PayMode };
export interface RefundRow { mode: PayMode; amountPaise: number }
export const PAY_MODES: readonly PayMode[] = ["cash", "upi", "card"];
export const REFUND_REASONS = ["Wrong item", "Quality complaint", "Long wait", "Guest changed mind", "Other"] as const;

/**
 * Where a refund goes by default: split across the guest's payment methods in proportion to what each still holds.
 * The rounding remainder goes to the largest holder, no method is asked for more than it holds, and zero rows are omitted.
 */
export function defaultRefundRows(paid: Array<{ mode: PaymentMode; amountPaise: number }>, refundable: Record<PayMode, number>, totalPaise: number): RefundRow[] {
  const modes = PAY_MODES.filter((mode) => paid.some((p) => p.mode === mode) && refundable[mode] > 0);
  const held = modes.reduce((sum, mode) => sum + refundable[mode], 0);
  const target = Math.min(Math.max(0, totalPaise), held);
  if (target <= 0) return [];
  const amounts = new Map<PayMode, number>(modes.map((mode) => [mode, Math.floor(target * refundable[mode] / held)]));
  let remainder = target - [...amounts.values()].reduce((sum, n) => sum + n, 0);
  for (const mode of [...modes].sort((a, b) => refundable[b] - refundable[a])) {
    const extra = Math.min(remainder, refundable[mode] - amounts.get(mode)!);
    amounts.set(mode, amounts.get(mode)! + extra);
    remainder -= extra;
  }
  return modes.map((mode) => ({ mode, amountPaise: amounts.get(mode)! })).filter((row) => row.amountPaise > 0);
}

/** The server's message for refund rows that cannot be saved, or null when they are valid. */
export function refundRowsError(rows: RefundRow[], totalPaise: number, refundable: Record<PayMode, number>): string | null {
  if (rows.reduce((sum, row) => sum + row.amountPaise, 0) !== totalPaise) return "Refund amounts must equal the credit note total";
  for (const mode of PAY_MODES) {
    const asked = rows.filter((row) => row.mode === mode).reduce((sum, row) => sum + row.amountPaise, 0);
    if (asked > refundable[mode]) return `Refund by ${mode} cannot exceed what was paid by ${mode}`;
  }
  return null;
}

/** Units of a billed line that can still be refunded. */
export function refundableQty(billed: number, refunded: number | undefined): number {
  return Math.max(0, billed - (refunded ?? 0));
}

/** A typed quantity as a whole number between 0 and what is left to refund. */
export function clampRefundQty(value: number, billed: number, refunded: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(refundableQty(billed, refunded), Math.max(0, Math.trunc(value)));
}

/** The reason sent to the server: a quick pick with optional detail, or free text ("Other" needs text). */
export function creditReason(pick: string, detail: string): string {
  const text = detail.trim();
  if (!pick || pick === "Other") return text;
  return text ? `${pick}: ${text}` : pick;
}

/** The badge for a bill: a void wins, then how much has been refunded, then paid or unpaid. */
export function billStatusLabel(bill: { status: "unpaid" | "paid" | "void"; refundState: "none" | "partly_refunded" | "refunded" }): string {
  if (bill.status === "void") return "VOID";
  if (bill.refundState === "refunded") return "Refunded";
  if (bill.refundState === "partly_refunded") return "Partly refunded";
  return bill.status === "paid" ? "Paid" : "Unpaid";
}
