/** How a bill's total is rounded: to the nearest ₹1 (default), to the nearest ₹0.50, or not at all. */
export const ROUND_OFF_MODES = ["rupee", "half", "off"] as const;
export type RoundOff = (typeof ROUND_OFF_MODES)[number];

/** Rounds an amount in paise half up to the chosen step. */
export function roundTotal(paise: number, mode: RoundOff): number {
  if (mode === "rupee") return Math.floor((paise + 50) / 100) * 100;
  if (mode === "half") return Math.floor((paise + 25) / 50) * 50;
  return paise;
}
