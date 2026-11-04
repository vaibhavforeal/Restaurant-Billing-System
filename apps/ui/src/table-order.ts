/**
 * Every table's id in the order shown after moving one table a place up or down, for PUT /api/tables/order (which saves the
 * whole order at once). Null when the table is already at that end.
 */
export function movedTableOrder(tables: { id: string }[], id: string, dir: -1 | 1): string[] | null {
  const from = tables.findIndex((t) => t.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= tables.length) return null;
  const ids = tables.map((t) => t.id);
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}
