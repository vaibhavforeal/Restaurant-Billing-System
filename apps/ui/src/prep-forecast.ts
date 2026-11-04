import type { PrepForecast } from "@masalapos/domain";

export interface PrepSheet {
  categories: Array<{ category: string; dishes: Array<{ name: string; plates: number; days: number[] }> }>;
  ingredients: Array<{ name: string; unit: string; need: number; onHand: number; buy: number }>;
}

/** Kilograms and litres to the nearest 10 g / 10 ml above; grams, millilitres and pieces to the whole unit above. */
const roundUp = (amount: number, unit: string) => {
  const step = unit === "kg" || unit === "L" ? 100 : 1;
  // Trim float noise first so 1.65 stays 1.65, not 1.6500000000000001 rounded up to 1.66.
  return Math.ceil(Math.round(amount * step * 1000) / 1000) / step;
};

/**
 * The printable prep sheet: plates rounded up after the safety margin, dishes grouped by category (busiest first, as
 * the hub sent them), and ingredients with what to buy (need less stock on hand, never below zero), to-buy first.
 */
export function prepSheet(forecast: PrepForecast, marginPercent: number): PrepSheet {
  const factor = 1 + marginPercent / 100;
  const categories: PrepSheet["categories"] = [];
  for (const dish of forecast.dishes) {
    const plates = Math.ceil(Math.round(dish.average * factor * 1000) / 1000);
    let group = categories.find((c) => c.category === dish.category);
    if (!group) { group = { category: dish.category, dishes: [] }; categories.push(group); }
    group.dishes.push({ name: dish.name, plates, days: dish.days });
  }
  for (const group of categories) group.dishes.sort((a, b) => b.plates - a.plates);
  const ingredients = forecast.ingredients.map((item) => {
    const need = roundUp(item.need * factor, item.unit);
    return { name: item.name, unit: item.unit, need, onHand: item.onHand, buy: roundUp(Math.max(0, need - Math.max(0, item.onHand)), item.unit) };
  });
  ingredients.sort((a, b) => Number(b.buy > 0) - Number(a.buy > 0) || a.name.localeCompare(b.name));
  return { categories, ingredients };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days the forecast can be asked for: today and the next 7, labelled "Tomorrow · Thu 5 Nov". */
export function prepDayChoices(today: string, daysAhead = 7): Array<{ value: string; label: string }> {
  return Array.from({ length: daysAhead + 1 }, (_, i) => {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) + i * DAY_MS);
    const value = day.toISOString().slice(0, 10);
    const name = day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
    return { value, label: i === 0 ? `Today · ${name}` : i === 1 ? `Tomorrow · ${name}` : name };
  });
}
