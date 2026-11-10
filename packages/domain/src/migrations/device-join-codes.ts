import type { Migration } from "../migrate.js";

/**
 * Short-lived codes that let a browser join the restaurant as a device, or take over an existing device. Only the hash of
 * a code is kept. A code that replaces a device carries that device's kind and name, copied when the code was made.
 * `created_by` is the administrator's name, which becomes the actor of the join in the device history.
 */
export const deviceJoinCodes: Migration = {
  version: 66,
  name: "device-join-codes",
  up(db) {
    db.exec(`
      CREATE TABLE device_join_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('counter','kitchen','captain')),
        name TEXT NOT NULL,
        replaces_device_id TEXT REFERENCES devices(id),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
  },
};
