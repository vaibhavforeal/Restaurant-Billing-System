export type PriceTier = "non_ac" | "ac" | "takeaway" | "zomato";

export const PRICE_TIER_LABELS: Record<PriceTier, string> = {
  non_ac: "Non-AC", ac: "AC", takeaway: "Takeaway", zomato: "Zomato",
};

export interface ItemPrices {
  pricePaise: number;
  acPricePaise?: number | null;
  takeawayPricePaise?: number | null;
  zomatoPricePaise?: number | null;
}

/** A missing service price falls back to this item's own Non-AC price; Zomato falls back to Takeaway first. A Zomato price of 0 is a real price. */
export function priceForTier(item: ItemPrices, tier: PriceTier): number {
  if (tier === "ac") return item.acPricePaise ?? item.pricePaise;
  if (tier === "zomato") return item.zomatoPricePaise ?? item.takeawayPricePaise ?? item.pricePaise;
  if (tier === "takeaway") return item.takeawayPricePaise ?? item.pricePaise;
  return item.pricePaise;
}
