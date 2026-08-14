import type { Database } from "./db.js";

/** Next value of a named gapless sequence. MUST be called inside the caller's transaction (single writer makes it safe). Creates the row on first use. */
export function nextSequence(db: Database, name: string): number {
  const row = db.prepare("UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value").get(name) as
    | { value: number }
    | undefined;
  if (row) return row.value;
  db.prepare("INSERT INTO sequences (name, value) VALUES (?, 1)").run(name);
  return 1;
}
