import type { Migration } from "../migrate.js";

/**
 * One device registry for every build. `devices` replaces `licensed_devices` and adds what the licence list never held:
 * the device's type, whether it is the main counter, and its settings (their shape comes with a later phase).
 * - Every licensed device is carried across as a counter, keeping its id, so its licence slot does not move.
 * - The oldest device still in use becomes the main counter. A database with none in use gets no main counter here; the
 *   server makes one the next time an admin signs in on the main PC.
 * - What happened to devices moves from `license_events` to `device_events`, leaving the licence history with licence
 *   events only. The `license_events` CHECK still lists the old device kinds; nothing writes them any more.
 */
export const devices: Migration = {
  version: 65,
  name: "devices",
  up(db) {
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('counter','kitchen','captain')),
        name TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
        settings TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        removed_at INTEGER,
        last_seen_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX idx_devices_main ON devices(is_main) WHERE is_main = 1;
      CREATE INDEX idx_devices_active ON devices(removed_at, created_at);
      CREATE TABLE device_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        actor_name TEXT NOT NULL,
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('joined','renamed','replaced','removed','settings_changed')),
        summary TEXT NOT NULL
      );

      INSERT INTO devices (id, kind, name, credential_hash, created_at, removed_at, last_seen_at, version)
        SELECT id, 'counter', name, credential_hash, created_at, revoked_at, last_seen_at, version FROM licensed_devices;
      UPDATE devices SET is_main = 1
        WHERE id = (SELECT id FROM devices WHERE removed_at IS NULL ORDER BY created_at, id LIMIT 1);

      INSERT INTO device_events (occurred_at, actor_name, device_id, kind, summary)
        SELECT occurred_at, actor_name, device_id,
          CASE kind WHEN 'device_registered' THEN 'joined' WHEN 'device_renamed' THEN 'renamed' ELSE 'removed' END, summary
        FROM license_events
        WHERE kind IN ('device_registered','device_renamed','device_removed') AND device_id IS NOT NULL
        ORDER BY id;
      DELETE FROM license_events WHERE kind IN ('device_registered','device_renamed','device_removed');

      DROP INDEX idx_licensed_devices_active;
      DROP TABLE licensed_devices;
    `);
  },
};
