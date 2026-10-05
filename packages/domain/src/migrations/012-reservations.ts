import type { Migration } from "../migrate.js";

export const migration012: Migration = {
  version: 12,
  name: "table-reservations",
  up(db) {
    db.exec(`
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY,
        client_ref TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        table_id TEXT NOT NULL REFERENCES dining_tables(id),
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 99),
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','seated','cancelled','no_show')),
        order_id TEXT UNIQUE REFERENCES orders(id),
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_reservations_table_time ON reservations(table_id, starts_at, ends_at);
      CREATE INDEX idx_reservations_schedule ON reservations(starts_at, status);
    `);
  },
};
