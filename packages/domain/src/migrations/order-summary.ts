import type { Migration } from "../migrate.js";

export const orderSummary: Migration = {
  version: 54,
  name: "order_summary",
  up(db) {
    db.exec(`
      ALTER TABLE orders ADD COLUMN order_notes TEXT NOT NULL DEFAULT '' CHECK (length(order_notes) <= 1000);
      ALTER TABLE orders ADD COLUMN guest_count INTEGER CHECK (guest_count BETWEEN 1 AND 999);
      ALTER TABLE orders ADD COLUMN sold_by_id TEXT REFERENCES users(id);
      ALTER TABLE orders ADD COLUMN sold_by_name TEXT;
      ALTER TABLE orders ADD COLUMN summary_revision INTEGER NOT NULL DEFAULT 0;
      UPDATE orders SET sold_by_id = opened_by, sold_by_name = (SELECT name FROM users WHERE id = orders.opened_by);
    `);
  },
};
