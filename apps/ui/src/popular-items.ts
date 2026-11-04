/** Popular products first, everything else after; both keep the order they had (a stable partition). */
export function withPopularFirst<T extends { id: string }>(products: T[], popularIds: readonly string[]): T[] {
  if (!popularIds.length) return products;
  const popular = new Set(popularIds);
  return [...products.filter((p) => popular.has(p.id)), ...products.filter((p) => !popular.has(p.id))];
}
