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

/** True for a real calendar day; `--MM-DD` (year not known) allows 29 February. */
function isCalendarDay(value: string): boolean {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = m[1] === "-" ? 2000 : Number(m[1]);
  const month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
/** A birthday or anniversary: `YYYY-MM-DD`, or `--MM-DD` when the year is not known. Empty means none. */
const Occasion = z.string().trim().transform((value, ctx) => {
  if (!value) return null;
  if (!isCalendarDay(value)) { ctx.addIssue({ code: "custom", message: "Use a date like 1990-03-14, or --03-14 without the year" }); return z.NEVER; }
  return value;
}).nullable();
const Email = z.string().trim().max(120).transform((value, ctx) => {
  if (!value) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { ctx.addIssue({ code: "custom", message: "Enter a valid email" }); return z.NEVER; }
  return value.toLowerCase();
}).nullable();
const Gender = z.enum(["female", "male", "other"]).nullable();
/** Tags are trimmed and de-duplicated ignoring case; the first spelling wins. */
const Tags = z.array(z.string().trim().min(1).max(30)).max(20).transform((tags) => {
  const seen = new Set<string>();
  return tags.filter((tag) => { const key = tag.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
});

export const CustomerCreate = z.object({
  name: Name, phone: Phone,
  typeId: z.string().min(1).nullable().default(null),
  notes: z.string().trim().max(500).default(""),
  email: Email.default(null),
  birthDate: Occasion.default(null),
  anniversaryDate: Occasion.default(null),
  gender: Gender.default(null),
  marketingOptIn: z.boolean().default(false),
  tags: Tags.default([]),
});
export const CustomerUpdate = z.object({
  name: Name.optional(), phone: Phone.optional(),
  typeId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  email: Email.optional(),
  birthDate: Occasion.optional(),
  anniversaryDate: Occasion.optional(),
  gender: Gender.optional(),
  marketingOptIn: z.boolean().optional(),
  isActive: z.boolean().optional(),
  /** When given, replaces the customer's tags. */
  tags: Tags.optional(),
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
/** The CRM settings added later are optional so an older client that sends only the first four keeps the rest. */
export const LoyaltySettingsUpdate = z.object({
  enabled: z.boolean(),
  pointsPer100: z.number().int().min(1).max(100),
  pointValuePaise: z.number().int().min(1).max(10_000),
  minRedeemPoints: z.number().int().min(0).max(1_000_000),
  /** Months after earning that points expire; 0 = never. */
  expiryMonths: z.number().int().min(0).max(120).optional(),
  tiersEnabled: z.boolean().optional(),
  tierWindowMonths: z.number().int().min(1).max(60).optional(),
  /** The most of a bill's total, in percent, that points may pay. */
  maxRedeemPercent: z.number().int().min(1).max(100).optional(),
  feedbackEnabled: z.boolean().optional(),
});
const Multiplier = z.number().min(1, "The multiplier is at least 1").max(10).transform((n) => Math.round(n * 100) / 100);
export const LoyaltyTierCreate = z.object({
  name: z.string().trim().min(1, "Enter a name").max(30),
  minSpendPaise: Paise,
  earnMultiplier: Multiplier.default(1),
});
export const LoyaltyTierUpdate = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  minSpendPaise: Paise.optional(),
  earnMultiplier: Multiplier.optional(),
  isActive: z.boolean().optional(),
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

/** Points earned on a bill total: `pointsPer100` points per full ₹100, times the tier's multiplier, rounded down. */
export const pointsEarned = (totalPaise: number, pointsPer100: number, multiplier = 1) =>
  Math.floor(Math.floor(totalPaise / 10_000) * pointsPer100 * Math.round(multiplier * 100) / 100);

export interface TierRule { id: string; name: string; minSpendPaise: number; earnMultiplier: number; isActive: boolean }
/** The highest active tier whose minimum spend the customer has reached, or null. */
export function tierFor<T extends TierRule>(tiers: T[], spendPaise: number): T | null {
  let best: T | null = null;
  for (const tier of tiers) {
    if (!tier.isActive || spendPaise < tier.minSpendPaise) continue;
    if (!best || tier.minSpendPaise > best.minSpendPaise) best = tier;
  }
  return best;
}

/**
 * Days from `todayKey` (YYYY-MM-DD) to the next time a birthday or anniversary (`YYYY-MM-DD` or `--MM-DD`) comes round:
 * 0 on the day itself. 29 February falls on 1 March in other years.
 */
export function daysUntilOccasion(occasion: string, todayKey: string): number {
  const [, month, day] = /(\d{2})-(\d{2})$/.exec(occasion)!.map(Number) as [number, number, number];
  const [y, m, d] = todayKey.split("-").map(Number) as [number, number, number];
  const today = Date.UTC(y, m - 1, d);
  let next = Date.UTC(y, month - 1, day);
  if (next < today) next = Date.UTC(y + 1, month - 1, day);
  return Math.round((next - today) / 86_400_000);
}

/** `ms` moved forward by whole calendar months, in local time; the day is clamped to the month's last day. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

const Rating = z.number().int().min(1, "Rate from 1 to 5").max(5);
/** A guest's or a staff member's rating of a visit. Only the overall rating is required. */
export const FeedbackSubmit = z.object({
  overall: Rating,
  food: Rating.nullable().default(null),
  service: Rating.nullable().default(null),
  ambience: Rating.nullable().default(null),
  comment: z.string().trim().max(1000).transform((s) => s || null).nullable().default(null),
});
