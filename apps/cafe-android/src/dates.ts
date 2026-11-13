import { businessDate } from "@masalapos/cafe-data";

/** Minutes east of UTC on this phone right now (India is 330). Bills use the same rule. */
export const deviceOffset = (now = Date.now()) => -new Date(now).getTimezoneOffset();

/** Today's business date on this phone, as "2026-11-13". */
export const today = () => businessDate(Date.now(), deviceOffset());

/** A business date moved by whole days. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** "11:35", 24-hour, for a bill's time in the device's zone. */
export function clockTime(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(11, 16);
}

/** A month's days as business dates, Monday first, with null for the blanks around them. */
export function monthGrid(year: number, month: number): Array<string | null> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-13" → "13 Nov 2026", without depending on the phone's locale data. */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
