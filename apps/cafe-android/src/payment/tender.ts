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
