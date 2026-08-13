import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

/**
 * Apply pending migrations. Each runs in its own transaction; user_version
 * is bumped inside that same transaction so a crash can never record a
 * migration it did not finish.
 */
export function migrate(db: Database, migrations: Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!;
    const cur = migrations[i]!;
    if (cur.version <= prev.version) {
      throw new Error(
        `migrations out of order: ${prev.name} (v${prev.version}) before ${cur.name} (v${cur.version})`,
      );
    }
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
