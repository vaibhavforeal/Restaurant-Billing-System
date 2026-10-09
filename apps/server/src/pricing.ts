import { priceForTier, type PriceTier, type Database } from "@forkflow/domain";

export interface PriceRow {
  price_paise: number;
  ac_price_paise: number | null;
  takeaway_price_paise: number | null;
  zomato_price_paise: number | null;
}

export function rowPrice(item: PriceRow, tier: PriceTier): number {
  return priceForTier({ pricePaise: item.price_paise, acPricePaise: item.ac_price_paise,
    takeawayPricePaise: item.takeaway_price_paise, zomatoPricePaise: item.zomato_price_paise }, tier);
}

export function tablePriceTier(db: Database, tableId: string): "non_ac" | "ac" {
  const table = db.prepare("SELECT price_tier FROM dining_tables WHERE id = ?").get(tableId) as { price_tier: "non_ac" | "ac" } | undefined;
  if (!table) throw new Error("Unknown table");
  return table.price_tier;
}
