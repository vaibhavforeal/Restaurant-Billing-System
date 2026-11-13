/** Indian digit grouping (1,23,456) without relying on the phone's Intl data. */
function groupIndian(rupees: string): string {
  if (rupees.length <= 3) return rupees;
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** 123450 → "₹1,234.50": Indian grouping, always two decimals. */
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(paise));
  return `${sign}₹${groupIndian(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
}

/** "12" → 1200, "12.5" → 1250, "1,234.50" → 123450. Null for blank, negative, more than two decimals or not a number. */
export function parseRupees(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}
