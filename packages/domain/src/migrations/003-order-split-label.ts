import type { Migration } from "../migrate.js";

/** M3s: per-split labels on dine-in orders (A, B, C…). Parcels stay NULL. */
export const migration003: Migration = {
  version: 3,
  name: "order-split-label",
  up(db) {
    db.exec(`
      ALTER TABLE orders ADD COLUMN split_label TEXT;
      UPDATE orders SET split_label = 'A' WHERE type = 'dine_in';
    `);
  },
};
