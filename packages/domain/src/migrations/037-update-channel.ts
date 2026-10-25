import type { Migration } from "../migrate.js";

/** The desktop auto-update channel chosen by the admin: stable releases, or patch (hotfix pre-releases as well). */
export const migration037: Migration = {
  version: 37,
  name: "update-channel",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'patch'))");
  },
};
