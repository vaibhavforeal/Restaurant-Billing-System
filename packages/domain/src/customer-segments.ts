import { z } from "zod";
import { daysUntilOccasion } from "./customers.js";

/**
 * Customer segments: a saved filter over customers and what they did. The server loads one summary row per customer
 * (`SegmentCustomer`) and keeps the rows `matchesSegment` accepts, so the rules live here, in one place, and are tested
 * without a database. Every condition left empty matches everyone.
 */
const Days = z.number().int().min(1).max(3650);
export const SegmentFilter = z.object({
  /** Tier ids; "none" matches customers below every tier. */
  tierIds: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** Customer type ids; "none" matches customers with no type. */
  typeIds: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** The customer has at least one of these tags (case is ignored). */
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  /** Visited within the last N days. */
  visitedWithinDays: Days.optional(),
  /** Has visited before, but not in the last N days. */
  notVisitedForDays: Days.optional(),
  /** Added as a customer within the last N days. */
  joinedWithinDays: Days.optional(),
  minVisits: z.number().int().min(0).max(100_000).optional(),
  minSpendPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  minPoints: z.number().int().min(0).max(100_000_000).optional(),
  /** A birthday and/or anniversary within the next N days (0 = today). */
  occasion: z.object({ kind: z.enum(["birthday", "anniversary", "either"]), withinDays: z.number().int().min(0).max(60) }).optional(),
  optedInOnly: z.boolean().default(false),
  includeInactive: z.boolean().default(false),
});
export type SegmentFilterInput = z.input<typeof SegmentFilter>;
export type SegmentFilterValue = z.output<typeof SegmentFilter>;

export const SegmentSave = z.object({ name: z.string().trim().min(1, "Give the segment a name").max(60), filter: SegmentFilter });

export interface SegmentCustomer {
  id: string; name: string; phone: string; email: string | null;
  typeId: string | null; typeName: string | null; tierId: string | null; tierName: string | null;
  tags: string[];
  visits: number; spendPaise: number; lastVisitAt: number | null; createdAt: number;
  points: number; birthDate: string | null; anniversaryDate: string | null;
  marketingOptIn: boolean; isActive: boolean;
}
export interface SavedSegment { id: string; name: string; filter: SegmentFilterValue; createdAt: number; updatedAt: number }

const DAY = 86_400_000;

export function matchesSegment(c: SegmentCustomer, f: SegmentFilterValue, now: number, todayKey: string): boolean {
  if (!f.includeInactive && !c.isActive) return false;
  if (f.optedInOnly && !c.marketingOptIn) return false;
  if (f.tierIds.length && !f.tierIds.includes(c.tierId ?? "none")) return false;
  if (f.typeIds.length && !f.typeIds.includes(c.typeId ?? "none")) return false;
  if (f.tags.length) {
    const own = new Set(c.tags.map((t) => t.toLowerCase()));
    if (!f.tags.some((t) => own.has(t.toLowerCase()))) return false;
  }
  if (f.visitedWithinDays !== undefined && (c.lastVisitAt === null || c.lastVisitAt < now - f.visitedWithinDays * DAY)) return false;
  if (f.notVisitedForDays !== undefined && (c.lastVisitAt === null || c.lastVisitAt >= now - f.notVisitedForDays * DAY)) return false;
  if (f.joinedWithinDays !== undefined && c.createdAt < now - f.joinedWithinDays * DAY) return false;
  if (f.minVisits !== undefined && c.visits < f.minVisits) return false;
  if (f.minSpendPaise !== undefined && c.spendPaise < f.minSpendPaise) return false;
  if (f.minPoints !== undefined && c.points < f.minPoints) return false;
  if (f.occasion) {
    const { kind, withinDays } = f.occasion;
    const soon = (date: string | null) => date !== null && daysUntilOccasion(date, todayKey) <= withinDays;
    const hit = kind === "birthday" ? soon(c.birthDate) : kind === "anniversary" ? soon(c.anniversaryDate) : soon(c.birthDate) || soon(c.anniversaryDate);
    if (!hit) return false;
  }
  return true;
}

/** Ready-made starting points in the segment builder. */
export const SEGMENT_PRESETS: Array<{ id: string; name: string; description: string; filter: SegmentFilterInput }> = [
  { id: "lapsed", name: "Lapsed 60 days", description: "Came before, but not in the last 60 days", filter: { notVisitedForDays: 60 } },
  { id: "regulars", name: "Regulars", description: "5 or more visits", filter: { minVisits: 5 } },
  { id: "new", name: "New this month", description: "Added in the last 30 days", filter: { joinedWithinDays: 30 } },
  { id: "birthdays", name: "Birthdays this week", description: "Birthday in the next 7 days", filter: { occasion: { kind: "birthday", withinDays: 7 } } },
  { id: "anniversaries", name: "Anniversaries this week", description: "Anniversary in the next 7 days", filter: { occasion: { kind: "anniversary", withinDays: 7 } } },
  { id: "points", name: "Points to spend", description: "100 or more points", filter: { minPoints: 100 } },
];

/** One CSV export row per customer: plain columns a spreadsheet or messaging tool can import. */
export const SEGMENT_CSV_COLUMNS = ["Name", "Phone", "Email", "Type", "Tier", "Tags", "Visits", "Spend (₹)", "Last visit", "Points", "Birthday", "Anniversary", "Marketing opt-in"] as const;
