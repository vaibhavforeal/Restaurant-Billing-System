import type { Migration } from "../migrate.js";

/**
 * Zomato desk: the minutes after punch-in at which a Zomato order card turns amber and red.
 * Defaults are 15 and 25; the restaurant changes them in Marketplace, Zomato, Settings.
 */
export const migration028: Migration = {
  version: 28,
  name: "zomato-age-thresholds",
  up(db) {
    db.exec(`
      ALTER TABLE zomato_settings ADD COLUMN warn_minutes INTEGER NOT NULL DEFAULT 15 CHECK (warn_minutes BETWEEN 1 AND 240);
      ALTER TABLE zomato_settings ADD COLUMN late_minutes INTEGER NOT NULL DEFAULT 25 CHECK (late_minutes BETWEEN 1 AND 240);
    `);
  },
};
