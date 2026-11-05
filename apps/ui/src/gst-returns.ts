import type { GstReturnsReport } from "@masalapos/domain/gst-returns";

/** The month GST returns open on: last month, the one a restaurant files for. `today` is YYYY-MM-DD. */
export function defaultGstMonth(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** e.g. masalapos-gst-returns-2026-10-01-to-2026-10-31.csv */
export const gstReturnsCsvName = (r: Pick<GstReturnsReport, "from" | "to">) => `masalapos-gst-returns-${r.from}-to-${r.to}.csv`;
/** The name GSTN tools expect is free-form; the GSTIN and return period make each file easy to find. */
export const gstr1JsonName = (gstin: string, fp: string) => `GSTR1_${gstin}_${fp}.json`;

/** Today on this device, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
