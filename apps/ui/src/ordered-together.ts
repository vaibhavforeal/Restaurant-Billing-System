export interface PairedDish { productId: string; variantId: string | null }
export type DishPairs = Record<string, PairedDish[]>;

/**
 * The "Goes well with" row for a cart: partners of the cart's dishes (from the hub's ordered-together list), leaving
 * out dishes already in the cart, categories already in the cart, and sold-out or unknown dishes. A dish suggested by
 * more of the cart comes first, then the better-ranked one, then partners of the dish added last. One per category.
 */
export function suggestTogether(cart: ReadonlyArray<{ productId: string }>, pairs: DishPairs,
  catalog: ReadonlyArray<{ id: string; categoryId: string; isSoldOut: boolean }>, limit = 3): PairedDish[] {
  const byId = new Map(catalog.map((dish) => [dish.id, dish]));
  const inCart = new Set(cart.map((item) => item.productId));
  const cartCategories = new Set([...inCart].flatMap((id) => byId.get(id)?.categoryId ?? []));
  const candidates = new Map<string, { pair: PairedDish; votes: number; rank: number; seen: number }>();
  let seen = 0;
  // Latest additions first, so their partners win ties.
  for (const productId of [...inCart].reverse()) {
    (pairs[productId] ?? []).forEach((pair, rank) => {
      const dish = byId.get(pair.productId);
      if (!dish || dish.isSoldOut || inCart.has(dish.id) || cartCategories.has(dish.categoryId)) return;
      const current = candidates.get(dish.id);
      if (current) { current.votes++; current.rank = Math.min(current.rank, rank); }
      else candidates.set(dish.id, { pair, votes: 1, rank, seen: seen++ });
    });
  }
  const ordered = [...candidates.values()].sort((a, b) => b.votes - a.votes || a.rank - b.rank || a.seen - b.seen);
  const categories = new Set<string>();
  const picked: PairedDish[] = [];
  for (const { pair } of ordered) {
    const category = byId.get(pair.productId)!.categoryId;
    if (categories.has(category)) continue;
    categories.add(category); picked.push(pair);
    if (picked.length === limit) break;
  }
  return picked;
}
