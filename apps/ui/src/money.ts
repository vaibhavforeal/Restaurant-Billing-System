export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

/** Parse a rupee input-field string to integer paise; null if unparseable or negative. */
export function rupeesToPaise(rupees: string): number | null {
  if (rupees.trim() === "") return null;
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
