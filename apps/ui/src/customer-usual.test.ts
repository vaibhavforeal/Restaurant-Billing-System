import { describe, expect, it } from "vitest";
import type { ComboGroup } from "@masalapos/domain/combos";
import type { Product } from "./types";
import { repeatPlan, usualChips, type LastOrder } from "./customer-usual";

function dish(id: string, extra: Partial<Product> = {}): Product {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), categoryId: "food", pricePaise: 10000, isVeg: true, isActive: true, isSoldOut: false,
    variants: [], kind: "item", ...extra } as Product;
}
const size = (id: string, pricePaise: number, isActive = true) => ({ id, name: id, pricePaise, isActive });
const fixed: ComboGroup[] = [{ id: "g1", name: "Included", minPicks: 2, maxPicks: 2, options: [
  { id: "o1", productId: "dal", variantId: null, name: "Dal", qty: 1, extraPricePaise: 0 },
  { id: "o2", productId: "rice", variantId: null, name: "Rice", qty: 2, extraPricePaise: 500 }] }];
const choose: ComboGroup[] = [{ id: "g2", name: "Main", minPicks: 1, maxPicks: 1, options: [
  { id: "o3", productId: "dal", variantId: null, name: "Dal", qty: 1, extraPricePaise: 0 },
  { id: "o4", productId: "paneer", variantId: null, name: "Paneer", qty: 1, extraPricePaise: 0 }] }];
const products = [
  dish("paneer", { variants: [size("half", 12000), size("full", 22000), size("jumbo", 30000, false)] }),
  dish("naan"), dish("dal"), dish("lassi", { isSoldOut: true }), dish("roti", { isActive: false }),
  dish("thali", { kind: "combo", combo: fixed, pricePaise: 25000 }), dish("meal", { kind: "combo", combo: choose }),
];

describe("usualChips", () => {
  it("shows up to 4 usual dishes in their usual size, leaving out dishes on the order and unavailable ones", () => {
    const dishes = [{ productId: "paneer", variantId: "full", bills: 4 }, { productId: "lassi", variantId: null, bills: 3 }, { productId: "naan", variantId: null, bills: 3 },
      { productId: "roti", variantId: null, bills: 2 }, { productId: "gone", variantId: null, bills: 2 }, { productId: "dal", variantId: null, bills: 2 },
      { productId: "thali", variantId: null, bills: 2 }, { productId: "meal", variantId: null, bills: 2 }];
    expect(usualChips(dishes, new Set(["naan"]), products).map(({ product, variant }) => [product.id, variant?.id ?? null]))
      .toEqual([["paneer", "full"], ["dal", null], ["thali", null], ["meal", null]]);
  });

  it("falls back to the first active size when the usual size is switched off", () => {
    const chips = usualChips([{ productId: "paneer", variantId: "jumbo", bills: 2 }], new Set(), products);
    expect(chips.map((chip) => chip.variant?.id)).toEqual(["half"]);
  });
});

describe("repeatPlan", () => {
  const last = (items: LastOrder["items"]): LastOrder => ({ billNo: 7, createdAt: 0, items });

  it("puts the last order back at today's prices, with quantities and sizes", () => {
    const plan = repeatPlan(last([
      { productId: "paneer", variantId: "half", name: "Paneer tikka (half)", qty: 2 },
      { productId: "naan", variantId: null, name: "Naan", qty: 3 },
    ]), products);
    expect(plan).toEqual({ skipped: [], rows: [
      { productId: "paneer", variantId: "half", name: "Paneer (half)", pricePaise: 12000, qty: 2 },
      { productId: "naan", variantId: null, name: "Naan", pricePaise: 10000, qty: 3 },
    ] });
  });

  it("adds a combo with fixed items, and names what it cannot add", () => {
    const plan = repeatPlan(last([
      { productId: "thali", variantId: null, name: "Thali", qty: 1 },
      { productId: "meal", variantId: null, name: "Meal", qty: 1 },
      { productId: "lassi", variantId: null, name: "Lassi", qty: 1 },
      { productId: "roti", variantId: null, name: "Roti", qty: 1 },
      { productId: "gone", variantId: null, name: "Old special", qty: 1 },
      { productId: "paneer", variantId: "jumbo", name: "Paneer (jumbo)", qty: 1 },
      { productId: "paneer", variantId: null, name: "Paneer", qty: 1 },
    ]), products);
    expect(plan.rows).toEqual([{ productId: "thali", variantId: null, name: "Thali", pricePaise: 25500, qty: 1, comboPicks: [], contents: ["Dal", "2 × Rice"] }]);
    expect(plan.skipped).toEqual(["Meal (choose its items from the menu)", "Lassi (sold out)", "Roti (no longer on the menu)",
      "Old special (no longer on the menu)", "Paneer (jumbo) (size no longer on the menu)", "Paneer (choose a size from the menu)"]);
  });
});
