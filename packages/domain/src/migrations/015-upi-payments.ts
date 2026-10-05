import type { Migration } from "../migrate.js";

export const migration015: Migration = {
  version: 15, name: "upi-payments",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN upi_id TEXT NOT NULL DEFAULT ''");
  },
};
