import type { Migration } from "../migrate.js";

/** Errors the app met on this phone, kept so a tester can share them; never synced. */
export const errorLog: Migration = {
  version: 3,
  up(db) {
    db.run("CREATE TABLE error_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL, stack TEXT, context TEXT)");
  },
};
