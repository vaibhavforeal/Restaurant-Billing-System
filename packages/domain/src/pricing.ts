export type PriceTier = "non_ac" | "ac" | "takeaway";

export const PRICE_TIER_LABELS: Record<PriceTier, string> = {
  non_ac: "Non-AC", ac: "AC", takeaway: "Takeaway",
};

export interface ItemPrices {
  pricePaise: number;
  acPricePaise?: number | null;
  takeawayPricePaise?: number | null;
}

/** A missing service price falls back to this item's own Non-AC price. */
export function priceForTier(item: ItemPrices, tier: PriceTier): number {
  if (tier === "ac") return item.acPricePaise ?? item.pricePaise;
  if (tier === "takeaway") return item.takeawayPricePaise ?? item.pricePaise;
  return item.pricePaise;
}
