import { describe, expect, it } from "vitest";
import type { PrepForecast } from "@masalapos/domain";
import { prepDayChoices, prepSheet } from "./prep-forecast";

const forecast: PrepForecast = {
  date: "2026-11-05", basedOn: ["2026-10-29", "2026-10-22", "2026-10-15", "2026-10-08"],
  dishes: [
    { productId: "l", variantId: "lg", name: "Lassi (Large)", category: "Drinks", average: 0.75, days: [2, 1, 0, 0] },
    { productId: "p", variantId: null, name: "Paneer tikka", category: "Mains", average: 3, days: [3, 5, 0, 4] },
    { productId: "d", variantId: null, name: "Dal", category: "Mains", average: 2.5, days: [2, 3, 3, 2] },
  ],
  ingredients: [
    { stockItemId: "c", name: "Curd", unit: "L", need: 1.5, onHand: 5 },
    { stockItemId: "o", name: "Onion", unit: "g", need: 820.4, onHand: 300 },
    { stockItemId: "p", name: "Paneer", unit: "kg", need: 0.9, onHand: -0.3 },
  ],
  unlinkedDishes: [],
};

describe("prepSheet", () => {
  it("rounds plates up, groups dishes by category and puts ingredients to buy first", () => {
    const sheet = prepSheet(forecast, 0);
    expect(sheet.categories).toEqual([
      { category: "Drinks", dishes: [{ name: "Lassi (Large)", plates: 1, days: [2, 1, 0, 0] }] },
      { category: "Mains", dishes: [{ name: "Paneer tikka", plates: 3, days: [3, 5, 0, 4] }, { name: "Dal", plates: 3, days: [2, 3, 3, 2] }] },
    ]);
    expect(sheet.ingredients).toEqual([
      { name: "Onion", unit: "g", need: 821, onHand: 300, buy: 521 },
      { name: "Paneer", unit: "kg", need: 0.9, onHand: -0.3, buy: 0.9 },
      { name: "Curd", unit: "L", need: 1.5, onHand: 5, buy: 0 },
    ]);
  });

  it("adds the safety margin before rounding up", () => {
    const sheet = prepSheet(forecast, 10);
    expect(sheet.categories[1]!.dishes.map((d) => d.plates)).toEqual([4, 3]);
    expect(sheet.ingredients.find((i) => i.name === "Curd")).toMatchObject({ need: 1.65, buy: 0 });
    expect(sheet.ingredients.find((i) => i.name === "Paneer")).toMatchObject({ need: 0.99, buy: 0.99 });
  });
});

describe("prepDayChoices", () => {
  it("offers today, tomorrow and the 6 days after, with weekday names", () => {
    const days = prepDayChoices("2026-11-04");
    expect(days).toHaveLength(8);
    expect(days[0]).toEqual({ value: "2026-11-04", label: "Today · Wed 4 Nov" });
    expect(days[1]).toEqual({ value: "2026-11-05", label: "Tomorrow · Thu 5 Nov" });
    expect(days[7]).toEqual({ value: "2026-11-11", label: "Wed 11 Nov" });
  });
});
