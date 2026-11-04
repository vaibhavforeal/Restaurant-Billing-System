import type { Migration } from "../migrate.js";

/** Popular items: the menu badges each category's best-seller unless the restaurant turns it off in Settings. */
export const popularItems: Migration = {
  version: 46,
  name: "popular_items",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN popular_items_enabled INTEGER NOT NULL DEFAULT 1 CHECK (popular_items_enabled IN (0, 1));");
  },
};
