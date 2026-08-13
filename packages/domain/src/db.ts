import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";

export type { Database };

/**
 * Open (or create) the POS database. The server is the only process that
 * ever calls this — single writer is an architectural invariant.
 */
export function openDb(path: string): Database {
  const db = new DatabaseCtor(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}
