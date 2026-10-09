/** "included": menu prices include GST, which is extracted per rate. "none": no GST is charged (composition scheme, or the platform pays it). */
export const GST_MODES = ["included", "none"] as const;
export type GstMode = typeof GST_MODES[number];

/** Rates a restaurant can pick as its default; items may still override with any rate calculateBill accepts. */
export const DEFAULT_GST_RATES = [5, 12, 18] as const;
export type DefaultGstRate = typeof DEFAULT_GST_RATES[number];

/** The rate an item is billed at: its own override wins, and 0 is a real override (a 0%-rated item); only null falls back to the restaurant default. */
export function effectiveGstRate(itemRate: number | null, defaultRate: number): number {
  return itemRate ?? defaultRate;
}

/**
 * Reads the mode of a stored receipt. All fields are optional because snapshots written
 * before `gstMode` existed carry only the legacy flags.
 */
export function receiptGstMode(receipt: { gstMode?: GstMode; gstPaidBy?: "zomato"; gstScheme?: "composition"; taxInclusive?: boolean }): GstMode {
  if (receipt.gstMode) return receipt.gstMode;
  return receipt.gstScheme === "composition" || receipt.gstPaidBy === "zomato" ? "none" : "included";
}
