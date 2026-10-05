import type { Migration } from "../migrate.js";

export const migration020: Migration = {
  version: 20,
  name: "kot-kitchen-acceptance",
  up(db) {
    db.exec(`ALTER TABLE kots ADD COLUMN accepted_at INTEGER;
      UPDATE kots SET accepted_at = done_at WHERE done_at IS NOT NULL;`);
  },
};
