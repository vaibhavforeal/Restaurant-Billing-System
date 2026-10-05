import { z } from "zod";

export const STOCK_UNITS = ["pcs", "kg", "g", "L", "ml"] as const;
export type StockUnit = typeof STOCK_UNITS[number];
export const STOCK_LIMIT = 1_000_000_000;

/** Use thousandths for calculations; tolerate only binary representation noise. */
export function stockMilli(value: number): number {
  const scaled = value * 1000;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(value) || Math.abs(value) > STOCK_LIMIT || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.0001) {
    throw new Error("Stock quantity must have at most 3 decimal places and be within the supported range");
  }
  return rounded;
}
export const StockQuantity = z.number().min(-STOCK_LIMIT).max(STOCK_LIMIT).refine((n) => {
  try { stockMilli(n); return true; } catch { return false; }
}, "Use at most 3 decimal places");
const Nonnegative = StockQuantity.refine((n) => n >= 0, "Quantity cannot be negative");
const Ref = z.string().min(8).max(64);
const Name = z.string().trim().min(1).max(120);
const Version = z.number().int().nonnegative();

export const StockCreate = z.object({
  clientRef: Ref, name: Name, unit: z.enum(STOCK_UNITS),
  openingQty: Nonnegative.default(0), lowStockThreshold: Nonnegative.nullable().default(null),
}).strict();
export const StockUpdate = z.object({
  expectedVersion: Version, name: Name.optional(), lowStockThreshold: Nonnegative.nullable().optional(), isActive: z.boolean().optional(),
}).strict();
export const StockAdjust = z.object({
  clientRef: Ref, expectedVersion: Version, reason: z.enum(["purchase", "wastage", "adjustment"]),
  quantity: Nonnegative, note: z.string().trim().min(1, "Enter a reason or reference").max(200),
  costPaise: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.costPaise !== undefined && v.reason !== "purchase") ctx.addIssue({ code: "custom", message: "Amount paid applies only to received stock", path: ["costPaise"] });
  if (v.reason !== "adjustment" && v.quantity <= 0) ctx.addIssue({ code: "custom", message: "Quantity must be positive", path: ["quantity"] });
});
export const UnitCostSet = z.object({
  clientRef: Ref, expectedVersion: Version,
  unitCostMilliPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  note: z.string().trim().min(1, "Enter a reason or reference").max(200),
}).strict();
export const StockLinkUpdate = z.object({
  expectedVersion: Version,
  stockItemId: z.string().min(1).nullable(),
  qtyPerSale: Nonnegative.refine((n) => n > 0 && n <= 1_000_000, "Use a quantity greater than zero, at most 1000000").default(1),
}).strict();

export interface StockItem {
  id: string; name: string; unit: StockUnit; qty: number; lowStockThreshold: number | null;
  isActive: boolean; isLow: boolean; version: number;
}
export interface StockWarning { id: string; name: string; unit: StockUnit; qty: number; lowStockThreshold: number | null }
export interface StockLink { id: string; stockItemId: string; qtyPerSale: number; stockName: string; unit: StockUnit }
export interface StockMove {
  id: string; stockItemId: string; delta: number; reason: "sale" | "purchase" | "adjustment" | "wastage" | "cancel_reversal";
  note: string | null; orderItemId: string | null; orderId: string | null; reversalOf: string | null;
  createdAt: number; createdByName: string | null; balanceAfter: number | null; costPaise?: number | null;
}
