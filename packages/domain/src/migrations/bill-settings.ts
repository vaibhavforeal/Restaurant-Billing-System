import type { Migration } from "../migrate.js";

/** Bill settings: a header printed under the restaurant name, and which optional lines a bill shows. */
export const billSettings: Migration = {
  version: 56,
  name: "bill_settings",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN receipt_header TEXT NOT NULL DEFAULT '';
      ALTER TABLE settings ADD COLUMN bill_show_fssai INTEGER NOT NULL DEFAULT 1 CHECK (bill_show_fssai IN (0,1));
      ALTER TABLE settings ADD COLUMN bill_show_customer INTEGER NOT NULL DEFAULT 1 CHECK (bill_show_customer IN (0,1));
      ALTER TABLE settings ADD COLUMN bill_show_table INTEGER NOT NULL DEFAULT 1 CHECK (bill_show_table IN (0,1));
      ALTER TABLE settings ADD COLUMN bill_show_served_by INTEGER NOT NULL DEFAULT 0 CHECK (bill_show_served_by IN (0,1));
      ALTER TABLE settings ADD COLUMN bill_show_item_gst INTEGER NOT NULL DEFAULT 0 CHECK (bill_show_item_gst IN (0,1));
    `);
  },
};
