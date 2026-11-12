import type { SqlDriver } from "./driver.js";

/** The next number for a named counter, starting at 1. Call inside the caller's transaction. */
export function nextSequence(db: SqlDriver, name: string): number {
  db.run("INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1", [name]);
  return db.get<{ value: number }>("SELECT value FROM sequences WHERE name = ?", [name])!.value;
}
