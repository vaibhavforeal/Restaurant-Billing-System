import { describe, expect, it } from "vitest";
import { defaultRecipeUnit, displayRecipeAmount, recipeAmount, recipeIsDirty, recipeWrite, switchRecipeUnit, type RecipeDraftRow } from "./recipe-quantities";

describe("recipe amount entry", () => {
  it("converts kitchen amounts into saved stock units", () => {
    expect(recipeAmount("250", "kg", "g")).toBe(0.25);
    expect(recipeAmount("15", "L", "ml")).toBe(0.015);
    expect(recipeAmount("0.25", "kg", "kg")).toBe(0.25);
    expect(recipeAmount("0.125", "g", "g")).toBe(0.125);
    expect(recipeAmount("2", "pcs", "pcs")).toBe(2);
    expect(defaultRecipeUnit("kg")).toBe("g");
    expect(defaultRecipeUnit("L")).toBe("ml");
    expect(displayRecipeAmount(0.125, "kg", "g")).toBe("125");
  });
  it("rejects loss of storage precision and incompatible units", () => {
    expect(() => recipeAmount("1.5", "kg", "g")).toThrow("whole g");
    expect(() => recipeAmount("0.0001", "kg", "kg")).toThrow();
    expect(() => recipeAmount("0.1234", "g", "g")).toThrow("3 decimal places");
    expect(() => recipeAmount("1", "kg", "ml")).toThrow("compatible");
    for (const amount of ["", " ", "NaN", "Infinity", "-1", "0", "1000001"]) expect(() => recipeAmount(amount, "pcs", "pcs")).toThrow();
    expect(recipeAmount("1", "kg", "g")).toBe(0.001);
    expect(recipeAmount("1000000000", "kg", "g")).toBe(1000000);
  });
  it("switches units without changing or rounding represented amounts", () => {
    expect(switchRecipeUnit("250", "kg", "g", "kg")).toBe("0.25");
    expect(switchRecipeUnit("0.25", "kg", "kg", "g")).toBe("250");
    expect(switchRecipeUnit("1.001", "kg", "kg", "g")).toBe("1001");
    expect(switchRecipeUnit("1.5", "L", "ml", "L")).toBe("0.0015");
    expect(switchRecipeUnit("", "kg", "g", "kg")).toBe("");
  });
  it("compares normalized recipes independent of row order or display unit", () => {
    const rows: RecipeDraftRow[] = [{ key: "a", stockItemId: "rice", quantity: "250.0", displayUnit: "g" }, { key: "b", stockItemId: "oil", quantity: "0.015", displayUnit: "L" }];
    const saved = [{ stockItemId: "oil", qtyPerSale: 0.015 }, { stockItemId: "rice", qtyPerSale: 0.25 }];
    const unitFor = (id: string) => id === "rice" ? "kg" : "L";
    expect(recipeIsDirty(rows, saved, unitFor)).toBe(false);
    expect(recipeIsDirty([{ ...rows[0]!, quantity: "" }, rows[1]!], saved, unitFor)).toBe(true);
    expect(recipeIsDirty([rows[0]!, rows[0]!], saved, unitFor)).toBe(true);
    expect(recipeIsDirty(rows, saved, () => undefined)).toBe(true);
  });
  it("preserves Basic single-link and Pro recipe write contracts", () => {
    const ingredients = [{ stockItemId: "rice", qtyPerSale: 0.25 }];
    expect(recipeWrite("dish", 4, ingredients, true)).toEqual({ path: "/api/products/dish/recipe", body: { expectedVersion: 4, ingredients } });
    expect(recipeWrite("dish", 4, ingredients, false)).toEqual({ path: "/api/products/dish/stock-links", body: { expectedVersion: 4, stockItemId: "rice", qtyPerSale: 0.25 } });
    expect(recipeWrite("dish", 4, [], false).body).toEqual({ expectedVersion: 4, stockItemId: null, qtyPerSale: 1 });
    expect(() => recipeWrite("dish", 4, [...ingredients, { stockItemId: "oil", qtyPerSale: 0.01 }], false)).toThrow("Pro");
  });
});
