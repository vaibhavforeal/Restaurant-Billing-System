import type { SlotBar } from "./dashboard-data";

/**
 * Value range for the slot chart. Net totals can be negative (credit notes dated on a day with fewer sales), so the
 * range always includes zero; an all-zero day gets a small positive range so nothing divides by zero.
 */
export function slotScale(bars: readonly SlotBar[]): { min: number; max: number } {
  const values = bars.flatMap((bar) => [bar.dineInPaise, bar.takeawayPaise]).filter(Number.isFinite);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return max === min ? { min: 0, max: 100 } : { min, max };
}

/** Approximate width of one character of an 11px semibold `.dash-bar-label` (tabular figures), in SVG units. */
export const BAR_LABEL_CHAR_PX = 6.8;

/**
 * Whether every slot can carry a value label above each of its two bars without the labels overlapping, or the chart
 * should fall back to one total label per slot. `pitch` is the distance between the centres of a slot's two bars;
 * `labels` are the compact texts that would be drawn ("₹12.3K", "-₹450"), zero bars already left out.
 */
export function perBarLabelsFit(pitch: number, labels: readonly string[]): boolean {
  // TODO(you): decide when per-bar labels fit. Placeholder approximates the old fixed `group >= 96` cut-off.
  return pitch >= 36 && labels.length >= 0;
}

/** Badge text for the Alerts panel; a truncated aggregator list is shown as a lower bound ("500+"). */
export function alertBadge(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}

/** "Updated just now / 1 min ago / N mins ago / N h ago" for the dashboard status strip. */
export function updatedLabel(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return "Not updated yet";
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours} h ago`;
}

/** Earliest date the dashboard picker offers; also the `min` on the input. */
export const DASHBOARD_MIN_DATE = "2000-01-01";

/**
 * The date to show for a picker value, or null to ignore it. Typing a year makes the browser emit each partial year
 * ("0002", "0020", "0202") as a complete date; the minimum keeps those from each firing a dashboard reload.
 */
export function pickedDate(value: string, today: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= DASHBOARD_MIN_DATE && value <= today ? value : null;
}

/** Readable aggregator status: "picked_up" becomes "Picked up". */
export function statusText(status: string): string {
  const text = status.replaceAll("_", " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Unknown";
}

export const paymentText = { prepaid: "Prepaid", cod: "COD", unknown: "Payment unknown" } as const;
