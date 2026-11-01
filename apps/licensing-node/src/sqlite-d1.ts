// A D1Like over a better-sqlite3 file, so the Worker's SQL and migrations run unchanged on a plain server.
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { D1Like, D1StatementLike } from "../../licensing-worker/src/env.js";

class Statement implements D1StatementLike {
  constructor(readonly db: Database.Database, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null); }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.params) as T[] }; }
  async run() { return this.runSync(); }
  runSync() { return { meta: { changes: this.db.prepare(this.sql).run(...this.params).changes } }; }
}

/** Applies each migrations/*.sql file once, in name order, remembering what ran so a restart is a no-op. */
export function migrate(db: Database.Database, migrationsDir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((row) => row.name));
  const applied: string[] = [];
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    // One transaction per file: a failing migration leaves the database exactly as it was.
    db.transaction(() => {
      db.exec(readFileSync(`${migrationsDir}/${name}`, "utf8"));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
    })();
    applied.push(name);
  }
  return applied;
}

export function fileD1(path: string, migrationsDir: string): { d1: D1Like; db: Database.Database; applied: string[] } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const applied = migrate(db, migrationsDir);
  const d1: D1Like = {
    prepare: (sql) => new Statement(db, sql),
    // Like D1, a batch is one transaction: any failing statement rolls everything back.
    async batch(statements) { return db.transaction(() => (statements as Statement[]).map((s) => s.runSync()))(); },
  };
  return { d1, db, applied };
}
