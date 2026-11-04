import type { Migration } from "../migrate.js";

/** Popular by time of day: the Popular badge follows the clock unless the restaurant turns it off in Settings. */
export const popularByTime: Migration = {
  version: 48,
  name: "popular_by_time",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN popular_by_time_enabled INTEGER NOT NULL DEFAULT 1 CHECK (popular_by_time_enabled IN (0, 1));");
  },
};
