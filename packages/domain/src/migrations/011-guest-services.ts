import type { Migration } from "../migrate.js";

export const migration011: Migration = {
  version: 11,
  name: "guest-service-requests",
  up(db) {
    db.exec(`
      CREATE TABLE guest_service_requests (
        id TEXT PRIMARY KEY,
        client_ref TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL REFERENCES dining_tables(id),
        table_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('waiter', 'bill')),
        receipt_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT REFERENCES users(id)
      );
      CREATE UNIQUE INDEX idx_guest_service_pending ON guest_service_requests(table_id, kind) WHERE status = 'pending';
      CREATE INDEX idx_guest_service_recent ON guest_service_requests(table_id, kind, created_at DESC);
      CREATE INDEX idx_guest_service_status ON guest_service_requests(status, created_at DESC);
    `);
  },
};
