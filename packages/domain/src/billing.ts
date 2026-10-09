import { z } from "zod";
import type { GstMode } from "./gst.js";
import type { ReceiptStyle } from "./receipt-styles.js";

const Paise = z.number().int().min(0).max(1_000_000_000);
const Ref = z.string().min(8).max(64);
export const BillPreview = z.object({
  discountPaise: Paise.default(0),
  discountNote: z.string().trim().max(200).default(""),
}).superRefine((v, ctx) => {
  if (v.discountPaise > 0 && !v.discountNote) ctx.addIssue({ code: "custom", message: "Discount reason required", path: ["discountNote"] });
});
export const BillCreate = BillPreview.safeExtend({
  clientRef: Ref,
  // Preview fingerprint prevents charging an order changed on another counter.
  previewKey: z.string().min(1).max(128),
  printerId: z.string().min(1).nullable().default(null),
});
export const BillSettle = z.object({
  clientRef: Ref,
  payments: z.array(z.object({
    mode: z.enum(["cash", "upi", "card"]),
    amountPaise: Paise.refine((n) => n > 0, "Payment must be positive"),
    refNote: z.string().trim().max(200).default(""),
  })).max(20),
});
export const BillPrint = z.object({ printerId: z.string().min(1) });
export type BillCreateInput = z.infer<typeof BillCreate>;
export type BillSettleInput = z.infer<typeof BillSettle>;

/**
 * Modes a bill payment can be recorded in; "zomato" is the platform receivable, never accepted by BillSettle.
 * Distinct from credit-notes' `PayMode`, which is the refund mode (cash, upi, card only).
 */
export type PaymentMode = "cash" | "upi" | "card" | "zomato";

export interface TaxLine { gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }
export interface BillTotals {
  subtotalPaise: number; discountPaise: number; cgstPaise: number;
  sgstPaise: number; roundingPaise: number; totalPaise: number; taxes: TaxLine[];
}
export interface ReceiptSnapshot {
  /** Missing on older bills, which continue to use the Classic layout. */
  receiptStyle?: ReceiptStyle;
  /** Absent on bills issued before UPI configuration was supported. */
  upiId?: string;
  gstMode: GstMode;
  /** Legacy: only on bills issued before `gstMode`; read through `receiptGstMode`. */
  taxInclusive?: boolean;
  restaurantName: string; address: string; gstin: string; fssai: string; receiptFooter: string;
  orderType: "dine_in" | "parcel" | "zomato"; tableName: string | null; splitLabel: string | null;
  /** Set on Zomato orders. */
  zomatoOrderId?: string;
  /** Set when the platform collects and pays the GST (section 9(5)). */
  gstPaidBy?: "zomato";
  /** Legacy: only on bills issued before `gstMode`; read through `receiptGstMode`. */
  gstScheme?: "composition";
  items: Array<{ name: string; pricePaise: number; qty: number; gstRate: number }>;
}
/** A void or refund as shown on its bill. */
export interface BillCreditNote {
  id: string; cnNo: number; kind: "void" | "refund"; reason: string; createdAt: number;
  totalPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
  requestedByName: string; approvedByName: string;
  refunds: Array<{ mode: "cash" | "upi" | "card"; amountPaise: number; refNote: string | null }>;
  lines: Array<{ orderItemId: string; name: string; qty: number; totalPaise: number }>;
}
export interface Bill extends BillTotals {
  id: string; billNo: number; orderId: string; status: "unpaid" | "paid" | "void";
  discountNote: string | null; createdAt: number; receipt: ReceiptSnapshot;
  payments: Array<{ mode: PaymentMode; amountPaise: number; refNote: string | null; createdAt: number }>;
  /** Derived from credit notes; the stored status is unchanged by a refund. */
  refundState: "none" | "partly_refunded" | "refunded";
  creditNotes: BillCreditNote[];
  /** Units already credited, keyed by order item id. */
  refundedQty: Record<string, number>;
}

/** All financial arithmetic uses integer paise / BigInt. */
export function calculateBill(items: Array<{ pricePaise: number; qty: number; gstRate: number }>, discountPaise = 0, mode: GstMode = "included"): BillTotals {
  if (!items.length) throw new Error("Bill must contain at least one item");
  const groups = new Map<number, number>();
  let subtotalPaise = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0 || !Number.isSafeInteger(item.qty) || item.qty < 1 ||
        ![0, 5, 12, 18, 28].includes(item.gstRate)) throw new Error("Invalid bill item");
    const amount = item.pricePaise * item.qty;
    subtotalPaise += amount;
    if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise > 1_000_000_000) throw new Error("Bill exceeds supported amount");
    groups.set(item.gstRate, (groups.get(item.gstRate) ?? 0) + amount);
  }
  if (!Number.isSafeInteger(discountPaise) || discountPaise < 0 || discountPaise > subtotalPaise) throw new Error("Discount exceeds subtotal");
  const allocation = [...groups.entries()].sort(([a], [b]) => a - b).map(([rate, amount]) => {
    const product = BigInt(amount) * BigInt(discountPaise);
    const denominator = BigInt(subtotalPaise || 1);
    return { rate, amount, discount: Number(product / denominator), remainder: product % denominator };
  });
  let remaining = discountPaise - allocation.reduce((sum, row) => sum + row.discount, 0);
  const byRemainder = [...allocation].sort((a, b) => a.remainder === b.remainder ? a.rate - b.rate : a.remainder > b.remainder ? -1 : 1);
  for (const row of byRemainder) { if (remaining-- > 0) row.discount++; }
  const taxes = allocation.map(({ rate, amount, discount }) => {
    const gross = amount - discount;
    if (mode === "none") return { gstRate: rate, taxablePaise: gross, cgstPaise: 0, sgstPaise: 0 };
    // Included: the discounted gross already contains the GST, so split it out.
    const divisor = BigInt(100 + rate);
    const taxablePaise = Number((BigInt(gross) * 200n + divisor) / (2n * divisor));
    const tax = gross - taxablePaise;
    const cgstPaise = Math.ceil(tax / 2);
    return { gstRate: rate, taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise };
  });
  const cgstPaise = taxes.reduce((sum, row) => sum + row.cgstPaise, 0);
  const sgstPaise = taxes.reduce((sum, row) => sum + row.sgstPaise, 0);
  const unrounded = subtotalPaise - discountPaise;
  const totalPaise = Math.floor((unrounded + 50) / 100) * 100;
  return { subtotalPaise, discountPaise, cgstPaise, sgstPaise, roundingPaise: totalPaise - unrounded, totalPaise, taxes };
}
