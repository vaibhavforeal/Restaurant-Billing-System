import { localDateKey } from "../dates.js";

export const DASHBOARD_PERIODS = ["today", "yesterday", "thisWeek", "thisMonth", "last7", "last30"] as const;
export type DashboardPeriod = typeof DASHBOARD_PERIODS[number];

export const DASHBOARD_COMPARES = ["none", "previous", "lastWeek"] as const;
export type DashboardCompare = typeof DASHBOARD_COMPARES[number];

/** Inclusive range of local YYYY-MM-DD keys. */
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/** Local midnight for a YYYY-MM-DD key. */
function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Calendar arithmetic in local time. No millisecond offsets, so DST cannot move a day. */
function addDays(key: string, days: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return localDateKey(d.getTime());
}

function shiftRange(range: DateRange, days: number): DateRange {
  return { from: addDays(range.from, days), to: addDays(range.to, days) };
}

/** Days from Monday up to the key. Monday is 0, Sunday is 6. */
function mondayOffset(key: string): number {
  return (parseKey(key).getDay() + 6) % 7;
}

function dayCount(range: DateRange): number {
  return Math.round((parseKey(range.to).getTime() - parseKey(range.from).getTime()) / DAY_MS) + 1;
}

/** Month-to-date against the same days of last month, clipped to the end of that month. */
function sameDaysLastMonth(range: DateRange): DateRange {
  const from = parseKey(range.from);
  const year = from.getFullYear();
  const month = from.getMonth();
  const lengthOfLastMonth = new Date(year, month, 0).getDate();
  const lastDay = Math.min(parseKey(range.to).getDate(), lengthOfLastMonth);
  return {
    from: localDateKey(new Date(year, month - 1, 1).getTime()),
    to: localDateKey(new Date(year, month - 1, lastDay).getTime()),
  };
}

/** The date range a preset covers, given today's local key. */
export function periodRange(period: DashboardPeriod, today: string): DateRange {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case "thisWeek":
      return { from: addDays(today, -mondayOffset(today)), to: today };
    case "thisMonth": {
      const start = parseKey(today);
      return { from: localDateKey(new Date(start.getFullYear(), start.getMonth(), 1).getTime()), to: today };
    }
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
  }
}

/** The range to compare against, or null when there is no comparison. */
export function compareRange(period: DashboardPeriod, range: DateRange, compare: DashboardCompare): DateRange | null {
  if (compare === "none") return null;
  // This week is compared with the same days last week, so it shifts by seven days like lastWeek.
  if (compare === "lastWeek" || period === "thisWeek") return shiftRange(range, -7);
  if (period === "thisMonth") return sameDaysLastMonth(range);
  // Otherwise the block of the same length right before the range.
  const length = dayCount(range);
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  thisMonth: "This month",
  last7: "Last 7 days",
  last30: "Last 30 days",
};

export const COMPARE_LABELS: Record<DashboardCompare, string> = {
  none: "No comparison",
  previous: "Previous period",
  lastWeek: "Same days last week",
};
