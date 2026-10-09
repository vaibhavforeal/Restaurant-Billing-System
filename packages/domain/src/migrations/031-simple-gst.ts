import type { Migration } from "../migrate.js";

/**
 * Two GST modes and a restaurant default rate. Settings lose `tax_inclusive` and `gst_scheme`;
 * a composition restaurant becomes "none", everyone else "included". A product at the default
 * rate (5) becomes null so it follows the restaurant default; other rates stay as overrides.
 */
export const migration031: Migration = {
  version: 31,
  name: "simple-gst",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN gst_mode TEXT NOT NULL DEFAULT 'included' CHECK (gst_mode IN ('included', 'none'));
      ALTER TABLE settings ADD COLUMN gst_rate INTEGER NOT NULL DEFAULT 5 CHECK (gst_rate IN (5, 12, 18));
      UPDATE settings SET gst_mode = CASE gst_scheme WHEN 'composition' THEN 'none' ELSE 'included' END;
      ALTER TABLE settings DROP COLUMN tax_inclusive;
      ALTER TABLE settings DROP COLUMN gst_scheme;

      ALTER TABLE products ADD COLUMN gst_rate_new REAL CHECK (gst_rate_new IS NULL OR gst_rate_new IN (0, 5, 12, 18, 28));
      UPDATE products SET gst_rate_new = gst_rate WHERE gst_rate <> 5;
      ALTER TABLE products DROP COLUMN gst_rate;
      ALTER TABLE products RENAME COLUMN gst_rate_new TO gst_rate;

      ALTER TABLE guest_requests DROP COLUMN tax_inclusive;
    `);
  },
};
