import { stockMilli, type StockUnit } from "./stock-schemas.js";
import type { PriceTier } from "./pricing.js";

/**
 * Weighted-average costing arithmetic. Costs are integer milli-paise (thousandths of a paise)
 * per one unit of an item's own unit; movement values are whole paise. All rounding is half
 * away from zero, with BigInt intermediates so large stock * cost products stay exact.
 */

const MILLI = 1_000_000n;

export interface StockCost {
  stockItemId: string; name: string; unit: StockUnit; qty: number; isActive: boolean;
  unitCostMilliPaise: number | null; valuePaise: number | null;
}
export interface DishPrice {
  tier: PriceTier; pricePaise: number; preGstPaise: number;
  costPercent: number | null; marginPaise: number | null;
}
export type DishCostStatus = "complete" | "incomplete" | "no_recipe";
export interface DishCost {
  productId: string; variantId: string | null; name: string; categoryName: string;
  costPaise: number | null; status: DishCostStatus; missing: string[]; prices: DishPrice[];
}
export interface StockCostChange {
  id: string; stockItemId: string; oldCostMilliPaise: number | null; newCostMilliPaise: number;
  note: string; createdAt: number; createdByName: string | null;
}

/** n / d rounded half away from zero (d must be positive). */
function roundDiv(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = (abs * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

function toSafeNumber(n: bigint): number {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error("Cost calculation is outside the supported range");
  return value === 0 ? 0 : value; // normalise -0
}

/** Average cost (milli-paise per unit) after adding `addQtyMilli` stock bought for `paidPaise`. */
export function blendUnitCost(oldQtyMilli: number, oldCost: number | null, addQtyMilli: number, paidPaise: number): number {
  if (!(addQtyMilli > 0)) throw new Error("Delivery quantity must be greater than zero");
  const add = BigInt(addQtyMilli);
  const paid = BigInt(paidPaise) * MILLI;
  if (oldQtyMilli <= 0 || oldCost === null) return toSafeNumber(roundDiv(paid, add));
  const old = BigInt(oldQtyMilli);
  return toSafeNumber(roundDiv(old * BigInt(oldCost) + paid, old + add));
}

/** Whole-paise value of a stock movement; null when the unit cost is unknown. */
export function moveCostPaise(deltaMilli: number, unitCost: number | null): number | null {
  if (unitCost === null) return null;
  return toSafeNumber(roundDiv(BigInt(deltaMilli) * BigInt(unitCost), MILLI));
}

/** Price before GST: unchanged when tax-exclusive, otherwise the tax is stripped out. */
export function preGstPaise(pricePaise: number, gstRate: number, taxInclusive: boolean): number {
  if (!taxInclusive) return pricePaise;
  const result = Math.round(Math.abs(pricePaise) * 100 / (100 + gstRate)) * Math.sign(pricePaise);
  return result === 0 ? 0 : result;
}

export function dishCost(links: Array<{ stockName: string; qtyPerSale: number; unitCostMilliPaise: number | null }>): {
  costPaise: number | null; status: DishCostStatus; missing: string[];
} {
  if (links.length === 0) return { costPaise: null, status: "no_recipe", missing: [] };
  const missing: string[] = [];
  let total = 0;
  for (const link of links) {
    const cost = moveCostPaise(stockMilli(link.qtyPerSale), link.unitCostMilliPaise);
    if (cost === null) missing.push(link.stockName);
    else total += cost;
  }
  if (missing.length > 0) return { costPaise: null, status: "incomplete", missing };
  return { costPaise: total, status: "complete", missing };
}
