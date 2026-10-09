import type { Migration } from "../migrate.js";

/** Regular GST registration, or the composition scheme, whose bills of supply carry no GST. */
export const migration030: Migration = {
  version: 30,
  name: "gst-scheme",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN gst_scheme TEXT NOT NULL DEFAULT 'regular' CHECK (gst_scheme IN ('regular', 'composition'))");
  },
};
