import { buildMenuEngineeringReport, buildStaffActivityReport, localDateKey, prepForecast, type ActivityEvent, type Database } from "@masalapos/domain";
import { z } from "zod";
import { profitLines } from "../costing.js";
import { moduleActive } from "../modules.js";
import { orderAnalyticsReport } from "../order-analytics.js";
import { reportRange, type ReportRange } from "../sales-reports.js";
import { ACTIVITY_BASELINE_DAYS, activityEvents, activityThresholds } from "../staff-activity.js";
import type { AiTool } from "./provider.js";

/**
 * The only things the assistant's model can see: read-only lookups over existing reports, returning figures, dish and
 * category names, and staff first names. Nothing here reads customers, and no free text staff typed (reasons, notes) is
 * passed on, since it could name a customer.
 */

const DATE = { type: "string", description: "YYYY-MM-DD" };
const RANGE = { type: "object", properties: { from: { ...DATE, description: "First day, YYYY-MM-DD (default: 6 days before 'to')" }, to: { ...DATE, description: "Last day, YYYY-MM-DD (default: today)" } }, additionalProperties: false };
const DAY_MS = 24 * 60 * 60 * 1000;

export const AI_TOOLS: AiTool[] = [
  { name: "sales_by_day", description: "Orders and net sales (₹) for each day in a date range.", parameters: RANGE },
  { name: "sales_by_hour", description: "Orders and net sales (₹) by hour of the day, over a date range.", parameters: RANGE },
  { name: "item_sales", description: "The 30 best-selling dishes by plates in a date range, optionally in one category.", parameters: { ...RANGE, properties: { ...RANGE.properties, category: { type: "string", description: "Category name, e.g. Starters" } } } },
  { name: "category_sales", description: "Plates, orders and net sales (₹) per menu category in a date range.", parameters: RANGE },
  { name: "order_types", description: "Orders, plates and net sales (₹) for dine-in, takeaway (parcel) and Zomato in a date range.", parameters: RANGE },
  { name: "menu_engineering", description: "Each dish's plates, margin per plate (₹) and group (Star, Plowhorse, Puzzle, Dog, or Needs a recipe cost) in a date range.", parameters: RANGE },
  { name: "prep_forecast", description: "Expected plates per dish for a day, from the same weekday in the last 4 weeks, and ingredients to buy.", parameters: { type: "object", properties: { date: DATE }, required: ["date"], additionalProperties: false } },
  { name: "staff_activity", description: "Per staff member (first names): cancellations after KOT, KOT cuts, voids and refunds, discounts, cash short, pay-outs, stock corrections, and flags, in a date range.", parameters: RANGE },
  { name: "today", description: "Today's date, weekday and the restaurant's timezone.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

const LABELS: Record<string, string> = {
  sales_by_day: "Sales by day", sales_by_hour: "Sales by hour", item_sales: "Item sales", category_sales: "Category sales",
  order_types: "Order types", menu_engineering: "Menu engineering", prep_forecast: "Prep forecast", staff_activity: "Staff activity", today: "Today's date",
};

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const rs = (paise: number) => Math.round(paise) / 100;
const RangeArgs = z.object({ from: z.string().optional(), to: z.string().optional() }).strict();
const ItemArgs = RangeArgs.extend({ category: z.string().max(80).optional() }).strict();
const DateArgs = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

function rangeOf(args: z.infer<typeof RangeArgs>): ReportRange {
  return reportRange({ ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) });
}
const span = (range: ReportRange) => `${range.from} to ${range.to}`;

function staffActivity(db: Database, range: ReportRange) {
  const named = (events: ActivityEvent[]) => events.map((e) => ({ ...e, staffName: firstName(e.staffName), detail: "", reference: null }));
  const [start, end] = range.bounds;
  const report = buildStaffActivityReport({ from: range.from, to: range.to, today: localDateKey(Date.now()), timezone: "", generatedAt: 0, days: range.dates.length,
    baselineDays: ACTIVITY_BASELINE_DAYS, events: named(activityEvents(db, start, end)), baseline: named(activityEvents(db, start - ACTIVITY_BASELINE_DAYS * DAY_MS, start)), thresholds: activityThresholds(db) });
  const [flagged, byStaff] = report.tables;
  return {
    flags: flagged!.rows.map((r) => ({ when: localDateKey(Number(r.at)), staff: r.staff, what: r.what, why: r.why, amountRs: r.amount === null ? null : rs(Number(r.amount)) })),
    byStaff: byStaff!.rows.map((r) => ({ staff: r.staff, cancelledAfterKot: r.cancelled, kotCuts: r.kotCuts, voidsAndRefunds: r.creditNotes, voidsAndRefundsRs: rs(Number(r.creditPaise)),
      discounts: r.discounts, discountsRs: rs(Number(r.discountPaise)), cashShortRs: rs(Number(r.cashShortPaise)), payOutsRs: rs(Number(r.payOutPaise)), stockCorrections: r.stockCorrections, flags: r.flags })),
  };
}

function lookup(db: Database, name: string, raw: unknown, now: number): { result: unknown; used: string } {
  switch (name) {
    case "sales_by_day": { const range = rangeOf(RangeArgs.parse(raw)); const r = orderAnalyticsReport(db, range, "all");
      return { result: { days: r.daily.map((d) => ({ date: d.date, orders: d.takeawayOrders + d.tableOrders, salesRs: rs(d.totalPaise) })) }, used: `${LABELS[name]}, ${span(range)}` }; }
    case "sales_by_hour": { const range = rangeOf(RangeArgs.parse(raw)); const r = orderAnalyticsReport(db, range, "all");
      return { result: { hours: r.hourly.map((h) => ({ hour: h.hour, orders: h.orderCount, salesRs: rs(h.totalPaise) })) }, used: `${LABELS[name]}, ${span(range)}` }; }
    case "item_sales": { const args = ItemArgs.parse(raw); const range = rangeOf(args); const r = orderAnalyticsReport(db, range, "all");
      const wanted = args.category?.trim().toLowerCase();
      const dishes = r.items.filter((i) => !wanted || i.category.toLowerCase() === wanted).slice(0, 30).map((i) => ({ dish: i.name, category: i.category, plates: i.qty, salesRs: rs(i.totalPaise) }));
      return { result: { dishes }, used: `${LABELS[name]}${args.category ? ` (${args.category})` : ""}, ${span(range)}` }; }
    case "category_sales": { const range = rangeOf(RangeArgs.parse(raw)); const r = orderAnalyticsReport(db, range, "all");
      return { result: { categories: r.categories.map((c) => ({ category: c.name, plates: c.qty, orders: c.orderCount, salesRs: rs(c.totalPaise) })) }, used: `${LABELS[name]}, ${span(range)}` }; }
    case "order_types": { const range = rangeOf(RangeArgs.parse(raw)); const r = orderAnalyticsReport(db, range, "all");
      return { result: { types: r.comparison.map((t) => ({ type: t.type, orders: t.orderCount, plates: t.qty, salesRs: rs(t.totalPaise) })) }, used: `${LABELS[name]}, ${span(range)}` }; }
    case "menu_engineering": { const range = rangeOf(RangeArgs.parse(raw));
      if (!moduleActive(db, "costing")) return { result: { error: "Dish costing isn't turned on, so margins aren't available." }, used: "" };
      const lines = db.transaction(() => profitLines(db, range.bounds))();
      const report = buildMenuEngineeringReport({ from: range.from, to: range.to, today: localDateKey(now), timezone: "", generatedAt: 0, lines });
      const dishes = report.tables.slice(1).flatMap((t) => t.rows.map((r) => ({ dish: r.dish, category: t.title, plates: r.plates, marginPerPlateRs: r.margin === null ? null : rs(Number(r.margin)), group: r.group })));
      return { result: { dishes }, used: `${LABELS[name]}, ${span(range)}` }; }
    case "prep_forecast": { const { date } = DateArgs.parse(raw); const f = prepForecast(db, date, localDateKey(now));
      return { result: { date: f.date, basedOn: f.basedOn, dishes: f.dishes.map((d) => ({ dish: d.name, category: d.category, expectedPlates: Math.ceil(d.average) })),
        ingredients: f.ingredients.map((i) => ({ item: i.name, unit: i.unit, need: i.need, inStock: i.onHand })) }, used: `${LABELS[name]}, ${date}` }; }
    case "staff_activity": { const range = rangeOf(RangeArgs.parse(raw));
      return { result: staffActivity(db, range), used: `${LABELS[name]}, ${span(range)}` }; }
    case "today": { z.object({}).strict().parse(raw);
      return { result: { date: localDateKey(now), weekday: new Date(now).toLocaleDateString("en-GB", { weekday: "long" }), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, used: LABELS[name]! }; }
    default: return { result: { error: `There is no lookup called ${name}.` }, used: "" };
  }
}

/** Runs one lookup the model asked for. Bad JSON, unknown names and bad arguments come back as `{"error": ...}`; it never throws. */
export function runTool(db: Database, name: string, argsJson: string, now: number): { content: string; used: string } {
  let raw: unknown;
  try { raw = argsJson.trim() ? JSON.parse(argsJson) : {}; } catch { return { content: JSON.stringify({ error: "The arguments were not valid JSON." }), used: "" }; }
  try {
    const { result, used } = lookup(db, name, raw, now);
    return { content: JSON.stringify(result), used };
  } catch (error) {
    const message = error instanceof z.ZodError ? "The arguments don't match this lookup: use YYYY-MM-DD dates." : error instanceof Error ? error.message : "The lookup failed.";
    return { content: JSON.stringify({ error: message }), used: "" };
  }
}
