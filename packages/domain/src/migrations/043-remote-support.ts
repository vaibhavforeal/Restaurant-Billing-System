import type { Migration } from "../migrate.js";

/**
 * Remote support. `settings.remote_support_enabled` lets an admin refuse every remote-access request without being asked (on by default:
 * each session still needs someone at the PC to allow it). `remote_support_log` is the restaurant's own record of every request, its
 * answer and how the session ended, kept on the PC whatever MasalaPOS's records say.
 */
export const migration043: Migration = {
  version: 43,
  name: "remote-support",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN remote_support_enabled INTEGER NOT NULL DEFAULT 1 CHECK (remote_support_enabled IN (0, 1));
      CREATE TABLE remote_support_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        at          INTEGER NOT NULL,
        event       TEXT NOT NULL CHECK (event IN ('requested', 'allowed', 'refused', 'started', 'ended')),
        agent_name  TEXT,
        actor_name  TEXT,
        detail      TEXT
      );
      CREATE INDEX idx_remote_support_log_at ON remote_support_log(at);
    `);
  },
};
