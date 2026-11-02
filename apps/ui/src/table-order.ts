/**
 * The sortOrder changes that move a table one place up or down in the displayed order. Tables that share a sortOrder
 * cannot be told apart by swapping, so the whole list is renumbered 1..n and only the tables whose number changes are returned.
 */
export function moveTablePatches(tables: { id: string; sortOrder: number }[], id: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  const from = tables.findIndex((t) => t.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= tables.length) return [];
  const order = [...tables];
  [order[from], order[to]] = [order[to]!, order[from]!];
  return order.flatMap((t, index) => t.sortOrder === index + 1 ? [] : [{ id: t.id, sortOrder: index + 1 }]);
}
