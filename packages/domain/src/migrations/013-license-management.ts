import type { Migration } from "../migrate.js";

export const migration013: Migration = {
  version: 13, name: "license-management",
  up(db) {
    db.exec(`
      ALTER TABLE licensed_devices ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE licensed_devices ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE license_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        actor_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('license_activated','device_registered','device_renamed','device_removed')),
        summary TEXT NOT NULL,
        revision INTEGER,
        device_id TEXT
      );
    `);
  },
};
