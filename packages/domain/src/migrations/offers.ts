import type { Migration } from "../migrate.js";

export const offers: Migration = {
  version: 63, name: "offers",
  up(db) {
    db.exec(`CREATE TABLE offers (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, revision INTEGER NOT NULL,
      rule_json TEXT NOT NULL CHECK(json_valid(rule_json))
    )`);
  },
};
