import type { DishCost, DishPrice } from "@forkflow/domain";
import { formatMovementCost } from "./stock-costs";

/** Upgrade note shown wherever costing is unavailable on Basic. All costing, whatever the recipe size, is Pro. */
export const COSTING_PRO_NOTE = "Ingredient costing and profit reports are part of the Pro plan.";

/** One service-price cell on the Dish costing tab: "price · cost % · margin", or why it cannot be costed. */
export function formatTierPrice(price: DishPrice | undefined): string {
  if (!price) return "—";
  if (price.preGstPaise === 0) return "no price"; // free item: there is nothing to measure cost % or margin against
  if (price.costPercent === null || price.marginPaise === null) return `${formatMovementCost(price.preGstPaise)} · cost unknown`;
  return `${formatMovementCost(price.preGstPaise)} · ${price.costPercent.toFixed(1)}% · ${price.marginPaise < 0 ? "loss " : "margin "}${formatMovementCost(Math.abs(price.marginPaise))}`;
}

const byName = (a: DishCost, b: DishCost) => a.name.localeCompare(b.name);
const nonAcPercent = (dish: DishCost) => dish.prices.find((price) => price.tier === "non_ac")?.costPercent ?? null;

/**
 * Split dishes for the Dish costing tab. Dishes without a recipe are listed apart; the rest are ordered by highest
 * non-AC cost % first, with rows that have no percent (incomplete recipes) last, then by name.
 */
export function sortDishes(dishes: DishCost[], category: string | "all"): { costed: DishCost[]; noRecipe: DishCost[] } {
  const inCategory = category === "all" ? dishes : dishes.filter((dish) => dish.categoryName === category);
  const costed = inCategory.filter((dish) => dish.status !== "no_recipe").sort((a, b) => {
    const left = nonAcPercent(a), right = nonAcPercent(b);
    if (left === null && right === null) return byName(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || byName(a, b);
  });
  const noRecipe = inCategory.filter((dish) => dish.status === "no_recipe").sort(byName);
  return { costed, noRecipe };
}
