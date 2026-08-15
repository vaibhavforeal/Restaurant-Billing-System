import type { Migration } from "../migrate.js";

/**
 * M3b: Add bluetooth kind to printers table. SQLite can't ALTER CHECK constraints,
 * so we rebuild via new-table pattern: create printers_new with the new CHECK,
 * copy all data, drop old, rename.
 */
export const migration004: Migration = {
  version: 4,
  name: "printer-kinds",
  up(db) {
    // Set defer_foreign_keys at connection level (persists through transaction).
    // This allows DROP TABLE printers even if kot_stations rows reference it,
    // since the renamed printers table will satisfy all FK constraints by commit time.
    const originalDefer = db.pragma("defer_foreign_keys", { simple: true }) as number;
    db.pragma("defer_foreign_keys = 1");

    try {
      // Create new table with updated CHECK constraint
      db.exec(`
        CREATE TABLE printers_new (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          kind         TEXT NOT NULL CHECK (kind IN ('network','windows','bluetooth')),
          connection   TEXT NOT NULL,
          paper_width  INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
          is_active    INTEGER NOT NULL DEFAULT 1
        )
      `);

      // Copy all existing data
      db.exec(`INSERT INTO printers_new SELECT * FROM printers`);

      // Drop old table
      db.exec(`DROP TABLE printers`);

      // Rename new table to original name
      db.exec(`ALTER TABLE printers_new RENAME TO printers`);
    } finally {
      // Restore original defer_foreign_keys state
      db.pragma(`defer_foreign_keys = ${originalDefer}`);
    }
  },
};
