import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  /** Holds every version up to its own at once (earlier migrations were folded into it); must come first. */
  baseline?: boolean;
  up(db: Database): void;
}

/**
 * Apply pending migrations. Each runs in its own transaction; user_version
 * is bumped inside that same transaction so a crash can never record a
 * migration it did not finish.
 *
 * The first migration may be a baseline holding every version up to its own: a
 * new database runs it, one at or past its version skips it, and one in
 * between is refused, since the steps it would need no longer exist.
 */
export function migrate(db: Database, migrations: Migration[]): void {
  for (const m of migrations) {
    if (m.version < 1) {
      throw new Error(`migration ${m.name} has version ${m.version} < 1`);
    }
  }
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!;
    const cur = migrations[i]!;
    if (cur.version <= prev.version) {
      throw new Error(
        `migrations out of order: ${prev.name} (v${prev.version}) before ${cur.name} (v${cur.version})`,
      );
    }
  }

  const start = db.pragma("user_version", { simple: true }) as number;
  const first = migrations[0];
  if (migrations.some((m, i) => m.baseline && i > 0)) throw new Error("a baseline migration must come first");
  if (first?.baseline && start > 0 && start < first.version) {
    throw new Error(`This database (version ${start}) is from a pre-release build older than this app can upgrade (from version ${first.version}). Start with a new database.`);
  }

  for (const m of migrations) {
    const current = db.pragma("user_version", { simple: true }) as number;
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }
}
