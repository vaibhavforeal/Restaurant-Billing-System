import type { Migration } from "../migrate.js";

/**
 * Hold orders: a dish can be held back from the kitchen until staff fire it (`held` only means something while the item is
 * pending; a combo's own line carries it), and the restaurant can turn the feature off in Settings.
 * Version 45 because Dynamic Reports owns 44 on its own branch.
 */
export const holdOrders: Migration = {
  version: 45,
  name: "hold_orders",
  up(db) {
    db.exec(`
      ALTER TABLE order_items ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1));
      ALTER TABLE settings ADD COLUMN hold_orders_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hold_orders_enabled IN (0, 1));
    `);
  },
};
