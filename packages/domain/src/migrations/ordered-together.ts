import type { Migration } from "../migrate.js";

/** Ordered together: the carts suggest dishes often on the same bill unless the restaurant turns it off in Settings. */
export const orderedTogether: Migration = {
  version: 47,
  name: "ordered_together",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN ordered_together_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ordered_together_enabled IN (0, 1));");
  },
};
