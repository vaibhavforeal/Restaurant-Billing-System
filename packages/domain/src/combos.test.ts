import { describe, expect, it } from "vitest";
import { ComboDefinition, ComboPickError, comboAvailable, comboSummary, isFixedGroup, resolveComboPicks, type ComboGroup } from "./combos.js";

const option = (id: string, name: string, extra: Partial<ComboGroup["options"][number]> = {}) =>
  ({ id, productId: `p-${id}`, variantId: null, name, qty: 1, extraPricePaise: 0, ...extra });
const groups = (): ComboGroup[] => [
  { id: "g1", name: "Included", minPicks: 2, maxPicks: 2, options: [option("burger", "Burger"), option("fries", "Fries")] },
  { id: "g2", name: "Drink", minPicks: 1, maxPicks: 1, options: [option("coke", "Coke"), option("shake", "Shake", { extraPricePaise: 3000 })] },
  { id: "g3", name: "Dessert", minPicks: 0, maxPicks: 2, options: [option("brownie", "Brownie", { extraPricePaise: 5000 }), option("kulfi", "Kulfi", { qty: 2, extraPricePaise: 4000 })] },
];

describe("combo picks", () => {
  it("adds fixed slots on their own and charges extras for the options picked", () => {
    const result = resolveComboPicks(groups(), ["shake", "kulfi"]);
    expect(result.items.map((i) => [i.name, i.qty, i.groupName])).toEqual([
      ["Burger", 1, "Included"], ["Fries", 1, "Included"], ["Shake", 1, "Drink"], ["Kulfi", 2, "Dessert"],
    ]);
    expect(result.extraPaise).toBe(7000);
    expect(comboSummary(result.items)).toBe("Burger, Fries, Shake, 2 × Kulfi");
  });

  it("refuses too few, too many, repeated, unknown and unavailable picks", () => {
    const fails = (picks: string[], value = groups()) => { try { resolveComboPicks(value, picks); return null; } catch (e) { expect(e).toBeInstanceOf(ComboPickError); return (e as Error).message; } };
    expect(fails([])).toBe("Choose 1 from Drink");
    expect(fails(["coke", "shake"])).toBe("Choose at most 1 from Drink");
    expect(fails(["coke", "coke"])).toBe("An item was picked twice");
    expect(fails(["coke", "gone"])).toBe("This combo changed. Choose its items again.");
    const soldOut = groups(); soldOut[0]!.options[1]!.unavailable = true;
    expect(fails(["coke"], soldOut)).toBe("Fries is not available");
    expect(fails(["coke"], [])).toBe("This combo has no items yet");
    const atLeast = groups(); atLeast[2]!.minPicks = 1;
    expect(fails(["coke"], atLeast)).toBe("Choose at least 1 from Dessert");
  });

  it("is available while fixed items and enough choices are", () => {
    expect(comboAvailable(groups())).toBe(true);
    const drinks = groups(); drinks[1]!.options.forEach((o) => { o.unavailable = true; });
    expect(comboAvailable(drinks)).toBe(false);
    const dessert = groups(); dessert[2]!.options.forEach((o) => { o.unavailable = true; });
    expect(comboAvailable(dessert)).toBe(true);
    expect(comboAvailable([])).toBe(false);
    expect(isFixedGroup(groups()[0]!)).toBe(true);
    expect(isFixedGroup(groups()[1]!)).toBe(false);
  });

  it("checks slot definitions", () => {
    const slot = (value: object) => ComboDefinition.safeParse([{ name: "Drink", options: [{ productId: "a" }, { productId: "b" }], ...value }]);
    expect(slot({ minPicks: 1, maxPicks: 1 }).success).toBe(true);
    expect(slot({ minPicks: 2, maxPicks: 1 }).success).toBe(false);
    expect(slot({ minPicks: 1, maxPicks: 3 }).success).toBe(false);
    expect(slot({ minPicks: 1, maxPicks: 1, options: [{ productId: "a" }, { productId: "a" }] }).success).toBe(false);
    expect(ComboDefinition.safeParse([]).success).toBe(false);
  });
});
