import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";

export interface ErrorEntry { at: number; message: string; stack: string | null; context: string | null }

const KEEP = 50;

/**
 * Records an error; only the newest 50 are kept, and long texts are cut. Never throws, and does not notify screens:
 * an error raised while drawing must not make the screens draw again.
 */
export function logError(db: SqlDriver, e: ErrorEntry): void {
  try {
    db.transaction(() => {
      db.run("INSERT INTO error_log (at, message, stack, context) VALUES (?, ?, ?, ?)",
        [e.at, e.message.slice(0, 2000), e.stack?.slice(0, 8000) ?? null, e.context?.slice(0, 500) ?? null]);
      db.run(`DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY id DESC LIMIT ${KEEP})`);
    });
  } catch { /* the log is best effort */ }
}

/** Newest first. */
export function listErrors(db: SqlDriver): ErrorEntry[] {
  return db.all<ErrorEntry>("SELECT at, message, stack, context FROM error_log ORDER BY id DESC");
}

export function clearErrors(db: SqlDriver): void {
  db.transaction(() => db.run("DELETE FROM error_log"));
  dataChanged();
}
