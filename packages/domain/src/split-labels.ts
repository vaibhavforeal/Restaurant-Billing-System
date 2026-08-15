import type { Database } from "./db.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Returns the next unused split label (A-Z) for the given table.
 * Considers orders with status 'open' or 'billed'.
 * Returns null if all 26 letters are taken.
 * Caller holds any transaction.
 */
export function nextSplitLabel(db: Database, tableId: string): string | null {
  const used = db
    .prepare(
      `SELECT split_label FROM orders
       WHERE table_id = ? AND status IN ('open', 'billed') AND split_label IS NOT NULL`
    )
    .all(tableId) as Array<{ split_label: string }>;

  const usedSet = new Set(used.map((r) => r.split_label));

  for (let i = 0; i < 26; i++) {
    const letter = LETTERS[i]!;
    if (!usedSet.has(letter)) return letter;
  }

  return null;
}
