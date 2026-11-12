import type { SqlDriver } from "./driver.js";

/** A number this device keeps for itself (not synced), or null when it was never set. */
export function getLocalState(db: SqlDriver, name: string): number | null {
  return db.get<{ value: number }>("SELECT value FROM local_state WHERE name = ?", [name])?.value ?? null;
}

/** Writes several local numbers in one transaction. */
export function setLocalState(db: SqlDriver, values: Record<string, number>): void {
  db.transaction(() => {
    for (const [name, value] of Object.entries(values)) {
      db.run("INSERT INTO local_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", [name, value]);
    }
  });
}
