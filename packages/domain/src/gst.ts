/**
 * "included": menu prices include GST, which is extracted per rate.
 * "exclusive": menu prices are before GST; CGST and SGST are added on the bill per rate.
 * "none": no GST is charged (composition scheme, or the platform pays it).
 */
export const GST_MODES = ["included", "exclusive", "none"] as const;
export type GstMode = typeof GST_MODES[number];

/** Whether a bill charged GST to the customer: either taxed mode, unless Zomato paid the GST. */
export function billChargesGst(r: { gstMode: GstMode; gstPaidBy?: "zomato" | undefined }): boolean {
  return r.gstPaidBy !== "zomato" && r.gstMode !== "none";
}

/** Rates a restaurant can pick as its default; items may still override with any rate calculateBill accepts. */
export const DEFAULT_GST_RATES = [5, 12, 18] as const;
export type DefaultGstRate = typeof DEFAULT_GST_RATES[number];

/** The rate an item is billed at: its own override wins, and 0 is a real override (a 0%-rated item); only null falls back to the restaurant default. */
export function effectiveGstRate(itemRate: number | null, defaultRate: number): number {
  return itemRate ?? defaultRate;
}
