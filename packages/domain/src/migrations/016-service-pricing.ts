import type { Migration } from "../migrate.js";

export const migration016: Migration = {
  version: 16, name: "service-pricing",
  up(db) {
    for (const table of ["products", "variants"]) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ac_price_paise INTEGER CHECK (ac_price_paise IS NULL OR (typeof(ac_price_paise) = 'integer' AND ac_price_paise >= 0));
        ALTER TABLE ${table} ADD COLUMN takeaway_price_paise INTEGER CHECK (takeaway_price_paise IS NULL OR (typeof(takeaway_price_paise) = 'integer' AND takeaway_price_paise >= 0));`);
    }
    db.exec(`ALTER TABLE dining_tables ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'non_ac' CHECK (price_tier IN ('non_ac', 'ac'));
      ALTER TABLE orders ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'non_ac' CHECK (price_tier IN ('non_ac', 'ac', 'takeaway'));
      UPDATE orders SET price_tier = 'takeaway' WHERE type = 'parcel';`);
  },
};
