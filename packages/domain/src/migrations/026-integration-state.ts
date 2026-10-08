import type { Migration } from "../migrate.js";

export const migration026: Migration = {
  version: 26,
  name: "integration-state",
  up(db) {
    // Marketplace on/off switches. No rows are seeded: a missing row means the integration is disabled.
    // Turning an integration off never deletes its data (e.g. zomato_orders stay).
    db.exec(`
      CREATE TABLE integration_state (
        id         TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(id)
      );
    `);
  },
};
