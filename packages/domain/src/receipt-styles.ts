/** Shared by settings, saved bill snapshots and browser-safe style selectors. */
export const RECEIPT_STYLES = ["classic", "modern", "heritage", "compact"] as const;
export type ReceiptStyle = typeof RECEIPT_STYLES[number];

/** Bills predating style selection retain the original receipt design. */
export function resolveReceiptStyle(value: unknown): ReceiptStyle {
  return typeof value === "string" && RECEIPT_STYLES.includes(value as ReceiptStyle) ? value as ReceiptStyle : "classic";
}
