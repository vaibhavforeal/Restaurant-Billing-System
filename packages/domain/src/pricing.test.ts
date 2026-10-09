import { describe, expect, it } from "vitest";
import { PRICE_TIER_LABELS, priceForTier } from "./pricing.js";

describe("priceForTier", () => {
  it("labels the Zomato tier", () => {
    expect(PRICE_TIER_LABELS.zomato).toBe("Zomato");
  });
  it("uses the Zomato price when set", () => {
    expect(priceForTier({ pricePaise: 250, takeawayPricePaise: 260, zomatoPricePaise: 290 }, "zomato")).toBe(290);
  });
  it("falls back to Takeaway, then to the base price", () => {
    expect(priceForTier({ pricePaise: 250, takeawayPricePaise: 260, zomatoPricePaise: null }, "zomato")).toBe(260);
    expect(priceForTier({ pricePaise: 250, takeawayPricePaise: 260 }, "zomato")).toBe(260);
    expect(priceForTier({ pricePaise: 250, takeawayPricePaise: null, zomatoPricePaise: null }, "zomato")).toBe(250);
  });
  it("treats a Zomato price of 0 as a real price", () => {
    expect(priceForTier({ pricePaise: 250, takeawayPricePaise: 260, zomatoPricePaise: 0 }, "zomato")).toBe(0);
  });
  it("leaves the other tiers unchanged", () => {
    const row = { pricePaise: 250, acPricePaise: 270, takeawayPricePaise: 260, zomatoPricePaise: 290 };
    expect(priceForTier(row, "non_ac")).toBe(250);
    expect(priceForTier(row, "ac")).toBe(270);
    expect(priceForTier(row, "takeaway")).toBe(260);
  });
});
