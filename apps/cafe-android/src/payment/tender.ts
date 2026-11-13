import { parseRupees } from "../money";
/** Change to give back, or null when the customer handed over less than the total. */
export function changeDue(totalPaise: number, tenderedPaise: number): number | null {
  return tenderedPaise < totalPaise ? null : tenderedPaise - totalPaise;
}

const roundUp = (paise: number, step: number) => Math.ceil(paise / step) * step;

/** Buttons for the cash screen: the exact total, then the total rounded up to ₹10, ₹50, ₹100 and ₹500 notes. */
export function cashSuggestions(totalPaise: number): number[] {
  if (totalPaise <= 0) return [];
  const all = [totalPaise, ...[1000, 5000, 10000, 50000].map((step) => roundUp(totalPaise, step))];
  return [...new Set(all)].sort((a, b) => a - b).slice(0, 4);
}

/** What a split payment still has to cover; never below zero. */
export function remaining(totalPaise: number, parts: readonly number[]): number {
  return Math.max(0, totalPaise - parts.reduce((sum, p) => sum + p, 0));
}

/** "120", "120.5" or "120.50" rupees as paise; anything else (blank, letters, three decimals, negative) is null. */
export function parseAmountPaise(text: string): number | null {
  return parseRupees(text);
}

/** A split is complete when every part is positive, no way to pay is used twice, there are two or more, and they add up. */
export function splitComplete(totalPaise: number, parts: ReadonlyArray<{ mode: "cash" | "upi" | "card"; amountPaise: number }>): boolean {
  if (parts.length < 2 || new Set(parts.map((p) => p.mode)).size !== parts.length) return false;
  if (parts.some((p) => !Number.isInteger(p.amountPaise) || p.amountPaise <= 0)) return false;
  return parts.reduce((n, p) => n + p.amountPaise, 0) === totalPaise;
}
