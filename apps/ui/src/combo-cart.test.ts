import { describe, expect, it } from "vitest";
import type { ComboGroup } from "@masalapos/domain/combos";
import { cartRowForKitchen, comboContents, comboExtraPaise, comboProductIds, isComboLine, kitchenLines } from "./combo-cart";
import type { OrderItem, Product } from "./types";

const product = (id: string, kotStationId: string | null, combo?: ComboGroup[]): Product => ({
  id, categoryId: "c", name: id, description: "", isSoldOut: false, photoVersion: null, photoUrl: null, pricePaise: 10000, gstRate: null,
  isVeg: true, kotStationId, isActive: true, variants: [], kind: combo ? "combo" : "item", ...(combo ? { combo } : {}),
});
const option = (id: string, productId: string, extraPricePaise = 0) => ({ id, productId, variantId: null, name: productId, qty: 1, extraPricePaise });
const groups: ComboGroup[] = [
  { id: "g1", name: "Included", minPicks: 1, maxPicks: 1, options: [option("o-burger", "burger")] },
  { id: "g2", name: "Drink", minPicks: 1, maxPicks: 1, options: [option("o-water", "water"), option("o-shake", "shake", 4000)] },
];
const catalog = [product("burger", null), product("water", null), product("shake", "bar"), product("combo", null, groups), product("dal", "kitchen")];
const line = (id: string, productId: string, extra: Partial<OrderItem> = {}): OrderItem => ({
  id, clientRef: null, productId, variantId: null, name: productId, pricePaise: 0, gstRate: 5, qty: 1, status: "pending", note: null, cancelReason: null, kotId: null, parentItemId: null, ...extra,
});

describe("combo cart", () => {
  it("knows a combo's items and extras from its picks", () => {
    expect(comboProductIds(groups, ["o-shake"])).toEqual(["burger", "shake"]);
    expect(comboExtraPaise(groups, ["o-shake"])).toBe(4000);
    expect(comboExtraPaise(groups, ["o-water"])).toBe(0);
  });

  it("sends a cart combo to the kitchen only when it holds a kitchen dish", () => {
    expect(cartRowForKitchen({ productId: "combo", comboPicks: ["o-shake"] }, catalog)).toBe(true);
    expect(cartRowForKitchen({ productId: "combo", comboPicks: ["o-water"] }, catalog)).toBe(false);
    expect(cartRowForKitchen({ productId: "dal" }, catalog)).toBe(true);
  });

  it("names combos, never the items in them, and lists what one combo holds", () => {
    const items = [
      line("c1", "combo", { qty: 2, pricePaise: 25000 }), line("c1a", "burger", { qty: 2, parentItemId: "c1" }), line("c1b", "shake", { qty: 4, parentItemId: "c1" }),
      line("c2", "combo"), line("c2a", "burger", { parentItemId: "c2" }), line("c2b", "water", { parentItemId: "c2" }),
      line("d", "dal"),
    ];
    expect(kitchenLines(items, catalog).map((item) => item.id)).toEqual(["c1", "d"]);
    expect(comboContents(items, items[0]!)).toEqual(["burger", "2 × shake"]);
    expect(isComboLine(items, items[0]!)).toBe(true);
    expect(isComboLine(items, items[6]!)).toBe(false);
  });
});
