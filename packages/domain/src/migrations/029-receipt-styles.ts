import type { Migration } from "../migrate.js";

export const migration029: Migration = {
  version: 29,
  name: "receipt-styles",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN receipt_style TEXT NOT NULL DEFAULT 'classic' CHECK (receipt_style IN ('classic', 'modern', 'heritage', 'compact'))");
  },
};
