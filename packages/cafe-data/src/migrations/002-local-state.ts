import type { Migration } from "../migrate.js";

/** Numbers this phone keeps for itself and never syncs, such as the owner PIN's wrong-try count and lock. */
export const localState: Migration = {
  version: 2,
  up(db) {
    db.run("CREATE TABLE local_state (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  },
};
