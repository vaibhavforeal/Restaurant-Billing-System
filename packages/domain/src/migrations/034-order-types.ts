import type { Migration } from "../migrate.js";

/**
 * Order types become a master list. The three built-in types keep the ids of the legacy `orders.type` values
 * ('dine_in', 'parcel', 'zomato'), which still drive behaviour (table, takeaway pricing, Zomato desk). A restaurant adds
 * its own takeaway or delivery types (e.g. "Home delivery"); those orders are `type = 'parcel'` and record the chosen type
 * in `orders.order_type_id` with a name snapshot for slips and bills. A NULL `order_type_id` means the built-in type named
 * by `orders.type`.
 */
export const migration034: Migration = {
  version: 34,
  name: "order-types",
  up(db) {
    db.exec(`
      CREATE TABLE order_types (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
        kind       TEXT NOT NULL CHECK (kind IN ('dine_in', 'takeaway', 'delivery', 'aggregator')),
        is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO order_types (id, name, kind, is_system, sort_order, created_at) VALUES
        ('dine_in', 'Dine-in', 'dine_in', 1, 0, 0),
        ('parcel', 'Takeaway', 'takeaway', 1, 1, 0),
        ('zomato', 'Zomato', 'aggregator', 1, 2, 0);
      ALTER TABLE orders ADD COLUMN order_type_id TEXT REFERENCES order_types(id);
      ALTER TABLE orders ADD COLUMN order_type_name TEXT;
      CREATE INDEX idx_orders_order_type ON orders(order_type_id) WHERE order_type_id IS NOT NULL;
    `);
  },
};
