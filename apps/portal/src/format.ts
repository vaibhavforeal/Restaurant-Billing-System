import { formatPaise } from "../../licensing-worker/src/portal/shared";

// Every date and time in the portal is shown in India time, whatever the browser's own zone.
const TZ = "Asia/Kolkata";
const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "30 Oct 2026" */
export const date = (at: number | null | undefined) => (at === null || at === undefined ? "—" : dateFmt.format(at));
/** "30 Oct 2026, 4:05 pm" */
export const dateTime = (at: number | null | undefined) => (at === null || at === undefined ? "—" : `${dateFmt.format(at)}, ${timeFmt.format(at)}`);
/** "2026-10-30", the India calendar day: for comparing days and for date inputs. */
export const isoDay = (at: number) => dayKey.format(at);
/** Midnight in India at the start of an ISO day ("2026-10-30"), for a date input's value. */
export const startOfIsoDay = (day: string) => Date.parse(`${day}T00:00:00+05:30`);

/** Days from today to `at` in whole India calendar days: 0 today, 1 tomorrow, -2 two days ago. */
export function daysFromToday(at: number, now = Date.now()): number {
  return Math.round((startOfIsoDay(isoDay(at)) - startOfIsoDay(isoDay(now))) / 86_400_000);
}

/** "Today", "Tomorrow", "In 5 days", "3 days ago", or the date when it is further off. */
export function relativeDay(at: number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return "—";
  const days = daysFromToday(at, now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days <= 14) return `In ${days} days`;
  if (days < -1 && days >= -14) return `${-days} days ago`;
  return date(at);
}

/** Money in rupees with Indian grouping, "₹1,23,456.00". */
export const money = (paise: number | null | undefined) => (paise === null || paise === undefined ? "—" : formatPaise(paise, "₹"));

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-IN")} ${count === 1 ? one : many}`;
