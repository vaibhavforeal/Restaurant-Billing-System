import type { Migration } from "../migrate.js";

export const migration019: Migration = {
  version: 19,
  name: "captains-per-customer-order",
  up(db) {
    // Keep captains already saved on orders; stop carrying table defaults into new visits.
    db.exec(`DROP TRIGGER IF EXISTS order_captain_snapshot;
      DROP TRIGGER IF EXISTS clear_inactive_captain;
      ALTER TABLE dining_tables DROP COLUMN captain_id;`);
  },
};
