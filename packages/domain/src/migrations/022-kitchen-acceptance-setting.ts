import type { Migration } from "../migrate.js";

export const migration022: Migration = {
  version: 22,
  name: "kitchen-acceptance-setting",
  up(db) {
    // On by default to keep the existing dine-in billing gate; print-only restaurants switch it off in Settings.
    db.exec("ALTER TABLE settings ADD COLUMN require_kitchen_acceptance INTEGER NOT NULL DEFAULT 1");
  },
};
