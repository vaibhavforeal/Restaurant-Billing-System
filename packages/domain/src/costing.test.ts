import { describe, expect, it } from "vitest";
import { blendUnitCost, moveCostPaise, preGstPaise, dishCost } from "./costing.js";

describe("weighted-average costing", () => {
  it("blends deliveries into a weighted average", () => {
    expect(blendUnitCost(10_000, 30_000_000, 10_000, 340_000)).toBe(32_000_000); // 10 kg @₹300 + 10 kg for ₹3,400 → ₹320/kg
  });
  it("starts fresh when stock was at or below zero, or cost unknown", () => {
    expect(blendUnitCost(-2_000, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
    expect(blendUnitCost(0, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
    expect(blendUnitCost(5_000, null, 5_000, 200_000)).toBe(40_000_000);
  });
  it("keeps cheap units precise", () => {
    expect(blendUnitCost(0, null, 100_000, 234)).toBe(2_340); // 100 ml for ₹2.34 → 2.34 paise/ml
    expect(moveCostPaise(-250_000, 2_340)).toBe(-585); // 250 ml used
  });
  it("handles large values without overflow", () => {
    expect(blendUnitCost(1_000_000_000, 100_000_000_000, 1_000_000_000, 1_000_000_000)).toBe(50_000_500_000); // (1e20 + 1e15) / 2e9
  });
  it("rejects a non-positive delivery quantity", () => {
    expect(() => blendUnitCost(0, null, 0, 100)).toThrow();
    expect(() => blendUnitCost(5_000, 100, -1, 100)).toThrow();
  });
  it("rounds half away from zero", () => {
    expect(blendUnitCost(0, null, 2_000_000, 3)).toBe(2); // 1.5 → 2
    expect(moveCostPaise(1, 1_500_000)).toBe(2); // 1.5 → 2
    expect(moveCostPaise(-1, 1_500_000)).toBe(-2); // -1.5 → -2
  });
  it("values movements and treats unknown cost as null", () => {
    expect(moveCostPaise(-1_500, 32_000_000)).toBe(-48_000);
    expect(moveCostPaise(-1, 1_500)).toBe(0); // rounds to zero; normalise -0 to 0
    expect(moveCostPaise(-1_500, null)).toBeNull();
  });
  it("converts tax-inclusive prices to pre-GST", () => {
    expect(preGstPaise(10_500, 5, true)).toBe(10_000);
    expect(preGstPaise(10_500, 5, false)).toBe(10_500);
    expect(preGstPaise(9_900, 0, true)).toBe(9_900);
  });
  it("costs a dish and flags missing ingredients", () => {
    expect(dishCost([])).toEqual({ costPaise: null, status: "no_recipe", missing: [] });
    expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Oil", qtyPerSale: 20, unitCostMilliPaise: 150 }]))
      .toEqual({ costPaise: 4_803, status: "complete", missing: [] });
    expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Cream", qtyPerSale: 0.05, unitCostMilliPaise: null }]))
      .toEqual({ costPaise: null, status: "incomplete", missing: ["Cream"] });
  });
});
