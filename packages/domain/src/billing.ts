import { z } from "zod";
import type { GstMode } from "./gst.js";
import type { ReceiptStyle } from "./receipt-styles.js";
import type { BillShow } from "./bill-print.js";
import { ValidGstin } from "./gstin-schema.js";
import { roundTotal, type RoundOff } from "./round-off.js";

const Paise = z.number().int().min(0).max(1_000_000_000);
const Ref = z.string().min(8).max(64);
/** A registered business the bill is issued to, which makes it a B2B invoice in GSTR-1. */
export const BuyerDetails = z.object({
  gstin: ValidGstin,
  name: z.string().trim().min(1, "Enter the business's legal name").max(100),
  address: z.string().trim().max(200).default(""),
});
export type BuyerDetailsInput = z.infer<typeof BuyerDetails>;
export const BillPreview = z.object({
  discountPaise: Paise.default(0),
  discountNote: z.string().trim().max(200).default(""),
  // An admin's PIN approves a discount above the signed-in user's limit. Never stored.
  approverPin: z.string().regex(/^\d{4,6}$/, "Enter the admin PIN").optional(),
  /** Loyalty points the order's customer spends on this bill, as a discount. */
  redeemPoints: z.number().int().min(0).max(1_000_000).default(0),
  /** The business buyer for a GST (B2B) invoice; null for a walk-in customer. */
  buyer: BuyerDetails.nullable().default(null),
  /** Cashier's choice to keep the service charge; false removes it from a dine-in bill. */
  serviceCharge: z.boolean().default(true),
  /** Offers the cashier switched off for this bill. */
  removedOfferIds: z.array(z.string().min(1).max(64)).max(50).default([]),
}).superRefine((v, ctx) => {
  if (v.discountPaise > 0 && !v.discountNote) ctx.addIssue({ code: "custom", message: "Discount reason required", path: ["discountNote"] });
});
export const BillCreate = BillPreview.safeExtend({
  clientRef: Ref,
  // Preview fingerprint prevents charging an order changed on another counter.
  previewKey: z.string().min(1).max(128),
  // Left out: the calling device's bill printer. A printer id: that printer for this bill. null: no thermal print.
  printerId: z.string().min(1).nullable().optional(),
});
export const BillSettle = z.object({
  clientRef: Ref,
  payments: z.array(z.object({
    mode: z.enum(["cash", "upi", "card"]),
    amountPaise: Paise.refine((n) => n > 0, "Payment must be positive"),
    refNote: z.string().trim().max(200).default(""),
  })).max(20),
});
/** The printer for one print request, read the same way as `BillCreate.printerId`. */
export const BillPrint = z.object({ printerId: z.string().min(1).nullable().optional() });
export type BillCreateInput = z.infer<typeof BillCreate>;
export type BillSettleInput = z.infer<typeof BillSettle>;

/**
 * Modes a bill payment can be recorded in; "zomato" is the platform receivable, never accepted by BillSettle.
 * Distinct from credit-notes' `PayMode`, which is the refund mode (cash, upi, card only).
 */
export type PaymentMode = "cash" | "upi" | "card" | "zomato";

export interface TaxLine { gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }
export type ChargeKind = "service" | "packaging";
/** A charge to add to a bill; `gstRate` is the restaurant's default rate, which the caller passes in. */
export type ChargeInput =
  | { kind: "service"; label: string; gstRate: number; bp: number }
  | { kind: "packaging"; label: string; gstRate: number; amountPaise: number };
/** A charge as priced on a bill. `percentBp` is set for a service charge, for printing. */
export interface ChargeLine {
  kind: ChargeKind; label: string; percentBp?: number; gstRate: number;
  amountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
}
/** A charge's name on a bill: the label, then its percentage when it has one (`Service charge 10%`). */
export const chargeLabel = (c: { label: string; percentBp?: number | null | undefined }) => c.percentBp ? `${c.label} ${c.percentBp / 100}%` : c.label;
export interface BillTotals {
  subtotalPaise: number;
  /** The total of every discount, offers included. */
  discountPaise: number;
  cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number; taxes: TaxLine[];
  /** Always set by `calculateBill`; optional so older payloads and fixtures still type-check. */
  charges?: ChargeLine[];
  /** The part of `discountPaise` that came from offers; present only when an offer applied. */
  offerDiscountPaise?: number;
}
export interface ReceiptSnapshot {
  /** Missing on older bills, which continue to use the Classic layout. */
  receiptStyle?: ReceiptStyle;
  /** Absent on bills issued before UPI configuration was supported. */
  upiId?: string;
  gstMode: GstMode;
  restaurantName: string; address: string; gstin: string; fssai: string; receiptFooter: string;
  /** The restaurant's phone; absent on bills issued before setup asked for it. */
  phone?: string;
  orderType: "dine_in" | "parcel" | "zomato"; tableName: string | null; splitLabel: string | null;
  /** Set on Zomato orders. */
  zomatoOrderId?: string;
  /** The restaurant's own order type (e.g. "Home delivery") on a takeaway order; absent for the built-in types. */
  orderTypeName?: string;
  /** The kind of the order's type; decides which charge applied. Absent on bills issued before charges. */
  orderTypeKind?: "dine_in" | "takeaway" | "delivery" | "aggregator";
  /** Set when the service charge was due but the cashier removed it. */
  serviceChargeRemoved?: true;
  /** The order's customer, with the discount and points this bill gave them. Absent when no customer was attached. */
  customer?: ReceiptCustomer;
  /** Set when the platform collects and pays the GST (section 9(5)). */
  gstPaidBy?: "zomato";
  /** The registered business this tax invoice was issued to (B2B). Absent for walk-in customers. */
  buyer?: ReceiptBuyer;
  /** The SAC code printed on a tax invoice; absent on bills issued before GST returns. */
  sacCode?: string;
  /** Header lines under the restaurant name; absent on bills issued before Bill settings. */
  receiptHeader?: string;
  /** Which optional lines this bill prints; absent means the defaults. */
  billShow?: BillShow;
  /** Who served the order, frozen whenever the order has a known staff name; the Bill settings toggle decides whether it prints. */
  servedBy?: string;
  /** `contents`: what one combo held, e.g. ["Veg Burger", "2 x Coke"]. `addon`: picked under the dish above it. */
  items: Array<{ name: string; pricePaise: number; qty: number; gstRate: number; contents?: string[]; addon?: boolean }>;
  /** The offers that took money off this bill, by name; absent when none applied. */
  offers?: Array<{ name: string; discountPaise: number }>;
}
export interface ReceiptBuyer {
  gstin: string; name: string; address: string;
  /** Place of supply: the restaurant's state, where restaurant service is supplied (IGST Act s.12(4)). */
  stateCode: string; stateName: string;
}
export interface ReceiptCustomer {
  name: string;
  /** Last four digits only, e.g. "******3210". */
  phone: string;
  typeName?: string;
  /** The loyalty tier the bill earned points at, when tiers are on. */
  tierName?: string;
  slabPercent?: number;
  customerDiscountPaise?: number;
  pointsRedeemed?: number;
  pointsValuePaise?: number;
  pointsEarned?: number;
  /** Balance after this bill's redemption and earning. */
  pointsBalance?: number;
}
/** A void or refund as shown on its bill. */
export interface BillCreditNote {
  id: string; cnNo: number;
  /** The financial-year reference that is printed (`CN/26-27/001`); a note from before references shows `CN-<cnNo>`. */
  creditNoteRef: string;
  kind: "void" | "refund"; reason: string; createdAt: number;
  totalPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
  requestedByName: string; approvedByName: string;
  refunds: Array<{ mode: "cash" | "upi" | "card"; amountPaise: number; refNote: string | null }>;
  lines: Array<{ orderItemId: string; name: string; qty: number; totalPaise: number }>;
  /** Charges this note credited (taxable + CGST + SGST); only a note that credits every remaining item or voids the bill has any. */
  charges: Array<{ kind: ChargeKind; label: string; totalPaise: number }>;
}
export interface Bill extends BillTotals {
  id: string; billNo: number;
  /** The financial-year invoice number that is printed (`MP/26-27/0001`); a bill from before invoice numbers shows its bill number. */
  invoiceNo: string;
  orderId: string; status: "unpaid" | "paid" | "void";
  discountNote: string | null; createdAt: number; receipt: ReceiptSnapshot;
  payments: Array<{ mode: PaymentMode; amountPaise: number; refNote: string | null; createdAt: number }>;
  /** Derived from credit notes; the stored status is unchanged by a refund. */
  refundState: "none" | "partly_refunded" | "refunded";
  creditNotes: BillCreditNote[];
  /** Units already credited, keyed by order item id. */
  refundedQty: Record<string, number>;
  /** Where the receipt's "Rate your visit" QR code points, while feedback is on. */
  feedbackUrl?: string;
}

/** Splits one rate's gross amount into taxable value, CGST and SGST under the three GST modes. */
function taxGroup(gross: number, rate: number, mode: GstMode): Omit<TaxLine, "gstRate"> {
  if (mode === "none") return { taxablePaise: gross, cgstPaise: 0, sgstPaise: 0 };
  // Exclusive: the amount is the taxable value; CGST and SGST are each half the rate on it, rounded half up, and added on top.
  if (mode === "exclusive") {
    const half = Number((BigInt(gross) * BigInt(rate) + 100n) / 200n);
    return { taxablePaise: gross, cgstPaise: half, sgstPaise: half };
  }
  // Included: the gross already contains the GST, so split it out. CGST and SGST are each half the rate on the same
  // taxable value, so they are always equal: when the rounded tax is odd, its odd paisa stays in the taxable value (each half
  // is then still within a paisa of taxable × rate / 2), and taxable + CGST + SGST is still exactly the gross.
  const divisor = BigInt(100 + rate);
  const rounded = Number((BigInt(gross) * 200n + divisor) / (2n * divisor));
  const half = Math.floor((gross - rounded) / 2);
  return { taxablePaise: gross - 2 * half, cgstPaise: half, sgstPaise: half };
}

/**
 * All financial arithmetic uses integer paise / BigInt.
 * A line's `offerDiscountPaise` comes off that line before GST; `discountPaise` is the bill-level discount, spread over what is left.
 */
export function calculateBill(items: Array<{ pricePaise: number; qty: number; gstRate: number; offerDiscountPaise?: number }>, discountPaise = 0, mode: GstMode = "included", roundOff: RoundOff = "rupee", charges: ChargeInput[] = []): BillTotals {
  if (!items.length) throw new Error("Bill must contain at least one item");
  const groups = new Map<number, number>();
  let subtotalPaise = 0;
  let offerDiscountPaise = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0 || !Number.isSafeInteger(item.qty) || item.qty < 1 ||
        ![0, 5, 12, 18, 28].includes(item.gstRate)) throw new Error("Invalid bill item");
    const amount = item.pricePaise * item.qty;
    const offer = item.offerDiscountPaise ?? 0;
    if (!Number.isSafeInteger(offer) || offer < 0 || offer > amount) throw new Error("Invalid bill item");
    subtotalPaise += amount;
    if (!Number.isSafeInteger(subtotalPaise) || subtotalPaise > 1_000_000_000) throw new Error("Bill exceeds supported amount");
    offerDiscountPaise += offer;
    groups.set(item.gstRate, (groups.get(item.gstRate) ?? 0) + amount - offer);
  }
  const afterOffersPaise = subtotalPaise - offerDiscountPaise;
  if (!Number.isSafeInteger(discountPaise) || discountPaise < 0 || discountPaise > afterOffersPaise) throw new Error("Discount exceeds subtotal");
  const totalDiscountPaise = offerDiscountPaise + discountPaise;
  const allocation = [...groups.entries()].sort(([a], [b]) => a - b).map(([rate, amount]) => {
    const product = BigInt(amount) * BigInt(discountPaise);
    const denominator = BigInt(afterOffersPaise || 1);
    return { rate, amount, discount: Number(product / denominator), remainder: product % denominator };
  });
  let remaining = discountPaise - allocation.reduce((sum, row) => sum + row.discount, 0);
  const byRemainder = [...allocation].sort((a, b) => a.remainder === b.remainder ? a.rate - b.rate : a.remainder > b.remainder ? -1 : 1);
  for (const row of byRemainder) { if (remaining-- > 0) row.discount++; }
  const taxes: TaxLine[] = allocation.map(({ rate, amount, discount }) => ({ gstRate: rate, ...taxGroup(amount - discount, rate, mode) }));
  // Each charge is taxed like a single-item group and its tax joins that rate's row (a new rate gets its own row).
  const lines: ChargeLine[] = [];
  for (const charge of charges) {
    if (![0, 5, 12, 18, 28].includes(charge.gstRate)) throw new Error("Invalid charge");
    let amountPaise: number;
    if (charge.kind === "service") {
      if (!Number.isSafeInteger(charge.bp) || charge.bp < 0 || charge.bp > 10_000) throw new Error("Invalid charge");
      amountPaise = Number((BigInt(subtotalPaise - totalDiscountPaise) * BigInt(charge.bp) + 5_000n) / 10_000n);
    } else {
      if (!Number.isSafeInteger(charge.amountPaise) || charge.amountPaise < 0 || charge.amountPaise > 1_000_000_000) throw new Error("Invalid charge");
      amountPaise = charge.amountPaise;
    }
    if (amountPaise === 0) continue;
    const tax = taxGroup(amountPaise, charge.gstRate, mode);
    lines.push({ kind: charge.kind, label: charge.label, ...(charge.kind === "service" ? { percentBp: charge.bp } : {}), gstRate: charge.gstRate, amountPaise, ...tax });
    // Each charge is taxed on its own ("taxed on their own"), so a merged rate row's CGST can differ by up to 1 paisa from taxing the combined amount once.
    const row = taxes.find((t) => t.gstRate === charge.gstRate);
    if (row) { row.taxablePaise += tax.taxablePaise; row.cgstPaise += tax.cgstPaise; row.sgstPaise += tax.sgstPaise; }
    else taxes.push({ gstRate: charge.gstRate, ...tax });
  }
  taxes.sort((a, b) => a.gstRate - b.gstRate);
  const chargesPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const cgstPaise = taxes.reduce((sum, row) => sum + row.cgstPaise, 0);
  const sgstPaise = taxes.reduce((sum, row) => sum + row.sgstPaise, 0);
  const unrounded = subtotalPaise - totalDiscountPaise + chargesPaise + (mode === "exclusive" ? cgstPaise + sgstPaise : 0);
  if (!Number.isSafeInteger(unrounded) || unrounded > 1_000_000_000) throw new Error("Bill exceeds supported amount");
  const totalPaise = roundTotal(unrounded, roundOff);
  return {
    subtotalPaise, discountPaise: totalDiscountPaise, ...(offerDiscountPaise > 0 ? { offerDiscountPaise } : {}),
    cgstPaise, sgstPaise, roundingPaise: totalPaise - unrounded, totalPaise, taxes, charges: lines,
  };
}
