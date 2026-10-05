import type { Migration } from "../migrate.js";

export const migration009: Migration = {
  version: 9,
  name: "guest-qr-ordering",
  up(db) {
    db.exec(`
      CREATE TABLE table_qr (
        table_id TEXT PRIMARY KEY REFERENCES dining_tables(id),
        token TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
      );
      CREATE TABLE guest_requests (
        id TEXT PRIMARY KEY,
        client_ref TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL REFERENCES dining_tables(id),
        table_name TEXT NOT NULL,
        receipt_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        items_json TEXT NOT NULL,
        subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
        tax_inclusive INTEGER NOT NULL CHECK (tax_inclusive IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reason TEXT,
        order_id TEXT REFERENCES orders(id),
        reviewed_at INTEGER,
        reviewed_by TEXT REFERENCES users(id),
        decision_json TEXT
      );
      CREATE INDEX idx_guest_pending ON guest_requests(status, table_id, expires_at);
    `);
  },
};
