import Database from "better-sqlite3";
import type { SqlDriver } from "../driver.js";
import { migrate } from "../migrate.js";

/** A better-sqlite3 adapter for tests. Its transaction refuses to nest, as expo-sqlite's synchronous one cannot. */
export function sqliteDriver(db: Database.Database): SqlDriver {
  let inTransaction = false;
  const args = (p?: readonly unknown[]) => (p ?? []) as unknown[];
  return {
    run(sql, p) { db.prepare(sql).run(...args(p)); },
    get<T>(sql: string, p?: readonly unknown[]) { return db.prepare(sql).get(...args(p)) as T | undefined; },
    all<T>(sql: string, p?: readonly unknown[]) { return db.prepare(sql).all(...args(p)) as T[]; },
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("nested transaction");
      inTransaction = true;
      db.exec("BEGIN");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (e) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw e;
      } finally {
        inTransaction = false;
      }
    },
  };
}

/** A migrated in-memory cafe database with foreign keys on. */
export function memoryCafeDb(): SqlDriver {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const db = sqliteDriver(raw);
  migrate(db);
  return db;
}
