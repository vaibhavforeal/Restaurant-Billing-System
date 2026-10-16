import type { Migration } from "../migrate.js";
export const migration033: Migration = {
  version: 33, name: "owner-feature-policy",
  up(db) { db.exec("CREATE TABLE owner_feature_policy (id INTEGER PRIMARY KEY CHECK(id=1), envelope TEXT NOT NULL, synced_at INTEGER NOT NULL)"); },
};
