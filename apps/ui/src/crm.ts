import { daysUntilOccasion } from "@masalapos/domain/customers";
import type { Customer } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Mar 1990", or "14 Mar" when the year is not known. */
export function formatOccasion(date: string): string {
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${m[1] === "-" ? "" : ` ${m[1]}`}`;
}

/** The date inputs a profile form edits: a day and month, plus an optional year. */
export function splitOccasion(date: string | null): { day: string; year: string } {
  if (!date) return { day: "", year: "" };
  const m = /^(\d{4}|-)-(\d{2}-\d{2})$/.exec(date);
  return m ? { day: m[2]!, year: m[1] === "-" ? "" : m[1]! } : { day: "", year: "" };
}
/** Back to the stored form from MM-DD and an optional year; empty when no day is given. */
export function joinOccasion(day: string, year: string): string {
  const d = day.trim();
  if (!d) return "";
  return /^\d{4}$/.test(year.trim()) ? `${year.trim()}-${d}` : `--${d}`;
}

/** A short note when a birthday or anniversary is within `days` either side of today, e.g. "Birthday in 2 days". */
export function occasionNote(customer: Pick<Customer, "birthDate" | "anniversaryDate">, todayKey: string, days = 3): string | null {
  const notes: string[] = [];
  for (const [label, date] of [["Birthday", customer.birthDate], ["Anniversary", customer.anniversaryDate]] as const) {
    if (!date) continue;
    const until = daysUntilOccasion(date, todayKey);
    if (until === 0) notes.push(`${label} today`);
    else if (until <= days) notes.push(`${label} in ${until} day${until === 1 ? "" : "s"}`);
    else if (until >= 365 - days) { const ago = 365 - until; notes.push(`${label} ${ago} day${ago === 1 ? "" : "s"} ago`); }
  }
  return notes.length ? notes.join(" · ") : null;
}

/** "★★★★☆" for 4 out of 5. */
export const stars = (rating: number) => "★".repeat(Math.round(rating)) + "☆".repeat(5 - Math.round(rating));

/** Splits typed tags on commas, trimming blanks. */
export const parseTags = (text: string) => text.split(",").map((t) => t.trim()).filter(Boolean);

/** Today's date as YYYY-MM-DD in local time. */
export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
