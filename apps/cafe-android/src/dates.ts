import { useEffect, useState } from "react";
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

/** How long ago a cart was held: "12 min" or "2 h" today, "yesterday", else the date. Calendar days in the device's zone. */
export function heldAge(createdAt: number, now: number, tzOffsetMinutes: number): string {
  const day = (ms: number) => new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
  const today = day(now);
  const held = day(createdAt);
  if (held === today) {
    const minutes = Math.max(1, Math.floor((now - createdAt) / 60_000));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
  }
  return held === addDays(today, -1) ? "yesterday" : longDate(held);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `now` to the next midnight in the device's zone; a full day when `now` is exactly midnight. */
export function msUntilNextLocalMidnight(now: number, tzOffsetMinutes: number): number {
  const local = now + tzOffsetMinutes * 60_000;
  return DAY_MS - (((local % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Today's business date, re-rendering at local midnight so a screen left open moves to the new day. */
export function useToday(): string {
  const [date, setDate] = useState(today);
  useEffect(() => {
    const now = Date.now();
    // A second past midnight, so the new date is certainly in force when the timer fires.
    const timer = setTimeout(() => setDate(today()), msUntilNextLocalMidnight(now, deviceOffset(now)) + 1000);
    return () => clearTimeout(timer);
  }, [date]);
  return date;
}
