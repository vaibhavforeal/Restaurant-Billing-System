/**
 * Calendar dates for the cafe, worked out from an explicit offset (minutes east of UTC; India is 330) rather than
 * the machine's time zone, so the phone and the tests agree.
 */
const shifted = (ms: number, tzOffsetMinutes: number) => new Date(ms + tzOffsetMinutes * 60_000);

/** The device's calendar date for a moment, as "2026-11-13". */
export function businessDate(ms: number, tzOffsetMinutes: number): string {
  return shifted(ms, tzOffsetMinutes).toISOString().slice(0, 10);
}

/** The Indian financial year (1 April to 31 March) containing a moment: { key: "2026-27", short: "26-27" }. */
export function cafeFinancialYear(ms: number, tzOffsetMinutes: number): { key: string; short: string } {
  const d = shifted(ms, tzOffsetMinutes);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const a = String(start % 100).padStart(2, "0");
  const b = String((start + 1) % 100).padStart(2, "0");
  return { key: `${start}-${b}`, short: `${a}-${b}` };
}
