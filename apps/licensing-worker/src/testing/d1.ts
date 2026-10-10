// Test-only: a D1Like over in-memory better-sqlite3. Never import this from Worker code.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { D1Like, D1StatementLike } from "../env.js";

const MIGRATION = new URL("../../migrations/0001_initial.sql", import.meta.url);

class Statement implements D1StatementLike {
  constructor(readonly db: Database.Database, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null); }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] }; }
  async run() { return this.runSync(); }
  runSync() { return { meta: { changes: this.db.prepare(this.sql).run(...this.params).changes } }; }
}

export function memoryD1(): D1Like {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(MIGRATION, "utf8"));
  return {
    prepare: (sql) => new Statement(db, sql),
    // Like D1, a batch is one transaction: any failing statement rolls everything back.
    async batch(statements) {
      return db.transaction(() => (statements as Statement[]).map((s) => s.runSync()))();
    },
  };
}
