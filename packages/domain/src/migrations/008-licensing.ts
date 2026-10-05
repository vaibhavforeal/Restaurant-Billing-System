import type { Migration } from "../migrate.js";

export const migration008: Migration = {
  version: 8, name: "licensing",
  up(db) {
    db.exec(`
      CREATE TABLE license_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        envelope TEXT,
        license_id TEXT,
        organization_id TEXT,
        outlet_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO license_state (id) VALUES (1);
      CREATE TABLE licensed_devices (
        id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX idx_licensed_devices_active ON licensed_devices(revoked_at, created_at);
    `);
  },
};
