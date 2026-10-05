import { describe, expect, it } from "vitest";
import type { DishCost } from "@forkflow/domain";
import { sortDishes } from "./dish-costing";

function dish(name: string, category: string, nonAcPercent: number | null, status: DishCost["status"] = nonAcPercent === null ? "incomplete" : "complete"): DishCost {
  const known = nonAcPercent !== null;
  return {
    productId: `p-${name}`, variantId: null, name, categoryName: category,
    costPaise: known ? 3000 : null, status, missing: status === "incomplete" ? ["Paneer"] : [],
    prices: [
      { tier: "ac", pricePaise: 20000, preGstPaise: 19048, costPercent: known ? 15 : null, marginPaise: known ? 16048 : null },
      { tier: "non_ac", pricePaise: 10000, preGstPaise: 9524, costPercent: nonAcPercent, marginPaise: known ? 6524 : null },
      { tier: "takeaway", pricePaise: 9000, preGstPaise: 8571, costPercent: known ? 35 : null, marginPaise: known ? 5571 : null },
    ],
  };
}

describe("sortDishes", () => {
  it("orders by highest non-AC cost percent first", () => {
    const { costed } = sortDishes([dish("Soup", "Starters", 20), dish("Biryani", "Mains", 45.5), dish("Naan", "Breads", 30)], "all");
    expect(costed.map((d) => d.name)).toEqual(["Biryani", "Naan", "Soup"]);
  });

  it("puts incomplete rows (no percent) last, then by name", () => {
    const { costed } = sortDishes([dish("Zebra", "Mains", null), dish("Apple", "Mains", null), dish("Soup", "Starters", 20), dish("Tea", "Drinks", 0)], "all");
    expect(costed.map((d) => d.name)).toEqual(["Soup", "Tea", "Apple", "Zebra"]);
  });

  it("breaks percent ties by name", () => {
    const { costed } = sortDishes([dish("Beta", "Mains", 30), dish("Alpha", "Mains", 30)], "all");
    expect(costed.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
  });

  it("filters by category", () => {
    const rows = [dish("Soup", "Starters", 20), dish("Biryani", "Mains", 45), dish("Pulao", "Mains", 25), dish("Water", "Drinks", 0, "no_recipe")];
    const mains = sortDishes(rows, "Mains");
    expect(mains.costed.map((d) => d.name)).toEqual(["Biryani", "Pulao"]);
    expect(mains.noRecipe).toEqual([]);
    expect(sortDishes(rows, "Drinks").noRecipe.map((d) => d.name)).toEqual(["Water"]);
  });

  it("lists dishes with no recipe separately, sorted by name", () => {
    const { costed, noRecipe } = sortDishes([dish("Water", "Drinks", null, "no_recipe"), dish("Soup", "Starters", 20), dish("Chai", "Drinks", null, "no_recipe")], "all");
    expect(costed.map((d) => d.name)).toEqual(["Soup"]);
    expect(noRecipe.map((d) => d.name)).toEqual(["Chai", "Water"]);
  });

  it("does not change the input order", () => {
    const rows = [dish("B", "Mains", 10), dish("A", "Mains", 50)];
    sortDishes(rows, "all");
    expect(rows.map((d) => d.name)).toEqual(["B", "A"]);
  });
});
