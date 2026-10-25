import type { Migration } from "../migrate.js";

/**
 * Customers, customer types with discount slabs, and loyalty points.
 * - A customer is identified by a 10-digit mobile number. A customer type (e.g. "Regular", "Staff") carries slabs: from a
 *   minimum bill subtotal, a percent off, optionally only between two dates. The best slab the bill qualifies for applies.
 * - `loyalty_ledger` is the append-only points history; a customer's balance is the sum of their rows. Points are earned on
 *   a bill's total at issue, can be redeemed as a discount, and are reversed by voids and refunds.
 * - A bill records its customer and the parts of its discount that came from the slab and from points, so the single
 *   `bills.discount_paise` (which GST, report lines and credit notes already use) stays the whole discount.
 */
export const migration036: Migration = {
  version: 36,
  name: "customers-and-loyalty",
  up(db) {
    db.exec(`
      CREATE TABLE customer_types (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
        is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE customer_type_slabs (
        id              TEXT PRIMARY KEY,
        type_id         TEXT NOT NULL REFERENCES customer_types(id),
        min_bill_paise  INTEGER NOT NULL CHECK (min_bill_paise >= 0),
        percent         REAL NOT NULL CHECK (percent > 0 AND percent <= 100),
        valid_from      TEXT CHECK (valid_from IS NULL OR valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        valid_to        TEXT CHECK (valid_to IS NULL OR valid_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
      );
      CREATE INDEX idx_customer_type_slabs_type ON customer_type_slabs(type_id);
      CREATE TABLE customers (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
        phone      TEXT NOT NULL UNIQUE CHECK (phone GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
        type_id    TEXT REFERENCES customer_types(id),
        notes      TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);
      CREATE TABLE loyalty_ledger (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        kind        TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'reverse', 'adjust')),
        points      INTEGER NOT NULL CHECK (points <> 0),
        bill_id     TEXT REFERENCES bills(id),
        credit_note_id TEXT REFERENCES credit_notes(id),
        note        TEXT,
        created_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id),
        client_ref  TEXT UNIQUE
      );
      CREATE INDEX idx_loyalty_customer ON loyalty_ledger(customer_id);
      CREATE INDEX idx_loyalty_bill ON loyalty_ledger(bill_id) WHERE bill_id IS NOT NULL;
      CREATE TRIGGER loyalty_ledger_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;
      CREATE TRIGGER loyalty_ledger_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;
      CREATE TABLE loyalty_settings (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        points_per_100      INTEGER NOT NULL DEFAULT 1 CHECK (points_per_100 BETWEEN 1 AND 100),
        point_value_paise   INTEGER NOT NULL DEFAULT 100 CHECK (point_value_paise BETWEEN 1 AND 10000),
        min_redeem_points   INTEGER NOT NULL DEFAULT 0 CHECK (min_redeem_points >= 0)
      );
      INSERT INTO loyalty_settings (id) VALUES (1);
      ALTER TABLE orders ADD COLUMN customer_id TEXT REFERENCES customers(id);
      ALTER TABLE bills ADD COLUMN customer_id TEXT REFERENCES customers(id);
      ALTER TABLE bills ADD COLUMN customer_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (customer_discount_paise >= 0);
      ALTER TABLE bills ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0);
      ALTER TABLE bills ADD COLUMN points_value_paise INTEGER NOT NULL DEFAULT 0 CHECK (points_value_paise >= 0);
      CREATE INDEX idx_bills_customer ON bills(customer_id) WHERE customer_id IS NOT NULL;
    `);
  },
};
