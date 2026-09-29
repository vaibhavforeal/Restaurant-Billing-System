import type { Migration } from "../migrate.js";

export const migration005: Migration = {
  version: 5,
  name: "billing-snapshots-and-idempotency",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN tax_inclusive INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0, 1));
      ALTER TABLE bills ADD COLUMN client_ref TEXT;
      ALTER TABLE bills ADD COLUMN request_json TEXT;
      ALTER TABLE bills ADD COLUMN receipt_json TEXT;
      CREATE UNIQUE INDEX idx_bills_client_ref ON bills(client_ref) WHERE client_ref IS NOT NULL;
      CREATE INDEX idx_bills_created ON bills(created_at);
      CREATE INDEX idx_payments_created ON payments(created_at);
      CREATE TABLE bill_settlements (
        bill_id TEXT PRIMARY KEY REFERENCES bills(id),
        client_ref TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
    `);
  },
};
