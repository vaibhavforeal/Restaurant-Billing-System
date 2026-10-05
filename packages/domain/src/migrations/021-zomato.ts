import type { Migration } from "../migrate.js";

export const migration021: Migration = {
  version: 21, name: "zomato-orders-and-reconciliation",
  up(db) {
    db.exec(`
      CREATE TABLE zomato_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_id TEXT NOT NULL DEFAULT '',
        restaurant_name TEXT NOT NULL DEFAULT '', pos_id TEXT NOT NULL DEFAULT '',
        webhook_base_url TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1, last_event_at INTEGER
      );
      INSERT INTO zomato_settings (id) VALUES (1);
      CREATE TABLE zomato_orders (
        restaurant_id TEXT NOT NULL, order_id TEXT NOT NULL, placed_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','confirmed','preparing','ready','picked_up','delivered','rejected','cancelled')),
        total_paise INTEGER NOT NULL CHECK(total_paise >= 0), payment_mode TEXT NOT NULL CHECK(payment_mode IN ('prepaid','cod','unknown')),
        items_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL CHECK(source IN ('import','webhook')),
        status_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, import_json TEXT,
        PRIMARY KEY (restaurant_id, order_id)
      );
      CREATE INDEX zomato_orders_date ON zomato_orders(restaurant_id, placed_at);
      CREATE INDEX zomato_orders_status ON zomato_orders(restaurant_id, status);
      CREATE TABLE zomato_events (
        restaurant_id TEXT NOT NULL, event_id TEXT NOT NULL, order_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL, payload_json TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (restaurant_id, event_id)
      );
      CREATE INDEX zomato_events_order ON zomato_events(restaurant_id, order_id, occurred_at);
      CREATE TABLE zomato_settlements (
        restaurant_id TEXT NOT NULL, entry_id TEXT NOT NULL, order_id TEXT NOT NULL,
        reference TEXT NOT NULL, settlement_date TEXT NOT NULL,
        gross_paise INTEGER NOT NULL CHECK(gross_paise >= 0), deductions_paise INTEGER NOT NULL CHECK(deductions_paise >= 0),
        additions_paise INTEGER NOT NULL CHECK(additions_paise >= 0), paid_paise INTEGER NOT NULL,
        import_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (restaurant_id, entry_id)
      );
      CREATE INDEX zomato_settlements_order ON zomato_settlements(restaurant_id, order_id);
      CREATE INDEX zomato_settlements_date ON zomato_settlements(restaurant_id, settlement_date);
      CREATE TABLE zomato_imports (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, restaurant_id TEXT NOT NULL, added INTEGER NOT NULL,
        skipped INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
      );
    `);
  },
};
