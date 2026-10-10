import type { SlotBar } from "./dashboard-data";

/**
 * Value range for the slot chart. Net totals can be negative (credit notes dated on a day with fewer sales), so the
 * range always includes zero; an all-zero day gets a small positive range so nothing divides by zero.
 */
export function slotScale(bars: readonly SlotBar[]): { min: number; max: number } {
  const values = bars.flatMap((bar) => [bar.dineInPaise, bar.takeawayPaise, bar.zomatoPaise]).filter(Number.isFinite);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return max === min ? { min: 0, max: 100 } : { min, max };
}

/** The slot chart's height when it is not stretched to fill a panel, and the smallest height it will be drawn at. */
export const SLOT_CHART_HEIGHT = 236;
export const SLOT_CHART_MIN_HEIGHT = 150;
const SLOT_CHART_TOP = 28, SLOT_CHART_LABEL_BAND = 44;

/**
 * Plot geometry for a slot chart drawn `height` SVG units tall: the bars sit between `top` and `bottom`, and a fixed band
 * below `bottom` carries the slot labels. A missing measurement falls back to the default height.
 */
export function slotChartFrame(height: number): { height: number; top: number; bottom: number } {
  const total = Number.isFinite(height) ? Math.max(SLOT_CHART_MIN_HEIGHT, Math.round(height)) : SLOT_CHART_HEIGHT;
  return { height: total, top: SLOT_CHART_TOP, bottom: total - SLOT_CHART_LABEL_BAND };
}

/** Approximate width of one character of an 11px semibold `.dash-bar-label` (tabular figures), in SVG units. */
export const BAR_LABEL_CHAR_PX = 6.8;

/**
 * Whether every slot can carry a value label above each of its bars without the labels overlapping, or the chart
 * should fall back to one total label per slot. `pitch` is the distance between the centres of neighbouring bars in a slot;
 * `labels` are the compact texts that would be drawn ("₹12.3K", "-₹450"), zero bars already left out.
 */
export function perBarLabelsFit(pitch: number, labels: readonly string[]): boolean {
  const longest = Math.max(0, ...labels.map((label) => label.length));
  const widthPx = longest * BAR_LABEL_CHAR_PX;
  return widthPx + 2 <= pitch;
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
