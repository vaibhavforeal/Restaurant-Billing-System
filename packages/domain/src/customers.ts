import { z } from "zod";

/**
 * An Indian mobile number as 10 digits: spaces, dashes, a leading 0 and a +91 / 91 prefix are removed.
 * Returns null when what is left is not a mobile number.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/[\s\-()]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

const Phone = z.string().trim().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (!phone) { ctx.addIssue({ code: "custom", message: "Enter a 10-digit mobile number" }); return z.NEVER; }
  return phone;
});
const Name = z.string().trim().min(1, "Enter a name").max(80);
const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-25");
const Paise = z.number().int().min(0).max(1_000_000_000);

export const CustomerCreate = z.object({
  name: Name, phone: Phone,
  typeId: z.string().min(1).nullable().default(null),
  notes: z.string().trim().max(500).default(""),
});
export const CustomerUpdate = z.object({
  name: Name.optional(), phone: Phone.optional(),
  typeId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
});
export const CustomerSlab = z.object({
  minBillPaise: Paise,
  percent: z.number().gt(0, "Percent must be above 0").max(100),
  validFrom: DateKey.nullable().default(null),
  validTo: DateKey.nullable().default(null),
}).refine((s) => !s.validFrom || !s.validTo || s.validFrom <= s.validTo, { message: "The slab ends before it starts", path: ["validTo"] });
export const CustomerTypeCreate = z.object({ name: z.string().trim().min(1, "Enter a name").max(40), slabs: z.array(CustomerSlab).max(20).default([]) });
/** `slabs`, when given, replaces the type's slabs. */
export const CustomerTypeUpdate = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
  slabs: z.array(CustomerSlab).max(20).optional(),
});
export const LoyaltySettingsUpdate = z.object({
  enabled: z.boolean(),
  pointsPer100: z.number().int().min(1).max(100),
  pointValuePaise: z.number().int().min(1).max(10_000),
  minRedeemPoints: z.number().int().min(0).max(1_000_000),
});
export const LoyaltyAdjust = z.object({
  clientRef: z.string().min(8).max(64),
  points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Enter points to add or remove"),
  note: z.string().trim().min(1, "Enter a reason").max(200),
});
export const OrderCustomerSet = z.object({ customerId: z.string().min(1).nullable() });

export interface SlabRule { minBillPaise: number; percent: number; validFrom: string | null; validTo: string | null }

/** The largest percent among the slabs this bill qualifies for on `date`, or 0. */
export function bestSlabPercent(slabs: SlabRule[], subtotalPaise: number, date: string): number {
  let best = 0;
  for (const slab of slabs) {
    if (subtotalPaise < slab.minBillPaise) continue;
    if (slab.validFrom && date < slab.validFrom) continue;
    if (slab.validTo && date > slab.validTo) continue;
    best = Math.max(best, slab.percent);
  }
  return best;
}

/** A percent off a subtotal, rounded down to the paisa so it never exceeds the percent. */
export const percentOf = (subtotalPaise: number, percent: number) => Math.floor(subtotalPaise * Math.round(percent * 100) / 10_000);

/** Points earned on a bill total: `pointsPer100` points per full ₹100. */
export const pointsEarned = (totalPaise: number, pointsPer100: number) => Math.floor(totalPaise / 10_000) * pointsPer100;
