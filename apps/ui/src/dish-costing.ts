import type { DishCost } from "@forkflow/domain";

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
