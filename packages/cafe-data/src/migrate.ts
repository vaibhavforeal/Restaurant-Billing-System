import type { SqlDriver } from "./driver.js";
import { MIGRATIONS } from "./migrations/index.js";

export interface Migration { version: number; up(db: SqlDriver): void }

/** Applies every migration newer than `PRAGMA user_version`, each in its own transaction. Returns the version reached. */
export function migrate(db: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): number {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const latest = sorted.at(-1)?.version ?? 0;
  let version = db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (version > latest) throw new Error("This data was made by a newer version of MasalaPOS Cafe");
  for (const m of sorted) {
    if (m.version <= version) continue;
    db.transaction(() => {
      m.up(db);
      db.run(`PRAGMA user_version = ${m.version}`);
    });
    version = m.version;
  }
  return version;
}
