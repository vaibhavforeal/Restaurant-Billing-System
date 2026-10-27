import type { Migration } from "../migrate.js";

const LEDGER_COLUMNS = ["id", "customer_id", "kind", "points", "bill_id", "credit_note_id", "note", "created_at", "created_by", "client_ref"].join(", ");

/**
 * CRM and loyalty: customer profiles, tags, optional spend-based tiers, points expiry, saved segments and bill feedback.
 * - Customers gain profile fields (email, birthday, anniversary, gender), a marketing opt-in and an active flag. A birthday
 *   or anniversary is `YYYY-MM-DD`, or `--MM-DD` when the year is not known.
 * - `loyalty_ledger` is rebuilt to allow `expire` rows and to carry `expires_at` on earned points. Rows written before this
 *   migration keep `expires_at = NULL` and never expire. Nothing references the ledger, so the rebuild is a plain copy;
 *   the append-only triggers are dropped first and recreated on the new table.
 * - Tiers are optional (`tiers_enabled`): a customer's tier is worked out from their spend over the last
 *   `tier_window_months`, never stored, and multiplies the points they earn.
 * - A bill gets a `feedback_token` at issue while feedback is on; the receipt's QR code links to it.
 */
export const migration039: Migration = {
  version: 39,
  name: "crm-loyalty",
  up(db) {
    db.exec(`
      ALTER TABLE customers ADD COLUMN email TEXT CHECK (email IS NULL OR email LIKE '%_@_%');
      ALTER TABLE customers ADD COLUMN birth_date TEXT CHECK (birth_date IS NULL OR birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR birth_date GLOB '--[0-1][0-9]-[0-3][0-9]');
      ALTER TABLE customers ADD COLUMN anniversary_date TEXT CHECK (anniversary_date IS NULL OR anniversary_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR anniversary_date GLOB '--[0-1][0-9]-[0-3][0-9]');
      ALTER TABLE customers ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('female', 'male', 'other'));
      ALTER TABLE customers ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1));
      ALTER TABLE customers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
      ALTER TABLE customers ADD COLUMN updated_at INTEGER;
      CREATE TABLE customer_tags (
        customer_id TEXT NOT NULL REFERENCES customers(id),
        tag         TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0),
        PRIMARY KEY (customer_id, tag)
      );
      CREATE INDEX idx_customer_tags_tag ON customer_tags(tag);

      DROP TRIGGER loyalty_ledger_no_update;
      DROP TRIGGER loyalty_ledger_no_delete;
      CREATE TABLE loyalty_ledger_new (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        kind        TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'reverse', 'adjust', 'expire')),
        points      INTEGER NOT NULL CHECK (points <> 0),
        bill_id     TEXT REFERENCES bills(id),
        credit_note_id TEXT REFERENCES credit_notes(id),
        note        TEXT,
        created_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id),
        client_ref  TEXT UNIQUE,
        expires_at  INTEGER CHECK (expires_at IS NULL OR points > 0)
      );
      INSERT INTO loyalty_ledger_new (rowid, ${LEDGER_COLUMNS}) SELECT rowid, ${LEDGER_COLUMNS} FROM loyalty_ledger;
      DROP TABLE loyalty_ledger;
      ALTER TABLE loyalty_ledger_new RENAME TO loyalty_ledger;
      CREATE INDEX idx_loyalty_customer ON loyalty_ledger(customer_id);
      CREATE INDEX idx_loyalty_bill ON loyalty_ledger(bill_id) WHERE bill_id IS NOT NULL;
      CREATE INDEX idx_loyalty_expiry ON loyalty_ledger(expires_at) WHERE expires_at IS NOT NULL;
      CREATE TRIGGER loyalty_ledger_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;
      CREATE TRIGGER loyalty_ledger_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;

      ALTER TABLE loyalty_settings ADD COLUMN expiry_months INTEGER NOT NULL DEFAULT 0 CHECK (expiry_months BETWEEN 0 AND 120);
      ALTER TABLE loyalty_settings ADD COLUMN tiers_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tiers_enabled IN (0, 1));
      ALTER TABLE loyalty_settings ADD COLUMN tier_window_months INTEGER NOT NULL DEFAULT 12 CHECK (tier_window_months BETWEEN 1 AND 60);
      ALTER TABLE loyalty_settings ADD COLUMN max_redeem_percent INTEGER NOT NULL DEFAULT 100 CHECK (max_redeem_percent BETWEEN 1 AND 100);
      ALTER TABLE loyalty_settings ADD COLUMN feedback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (feedback_enabled IN (0, 1));
      CREATE TABLE loyalty_tiers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
        min_spend_paise INTEGER NOT NULL CHECK (min_spend_paise >= 0),
        earn_multiplier REAL NOT NULL DEFAULT 1 CHECK (earn_multiplier >= 1 AND earn_multiplier <= 10),
        is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE customer_segments (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
        filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id)
      );

      ALTER TABLE bills ADD COLUMN feedback_token TEXT;
      CREATE UNIQUE INDEX idx_bills_feedback_token ON bills(feedback_token) WHERE feedback_token IS NOT NULL;
      CREATE TABLE customer_feedback (
        id          TEXT PRIMARY KEY,
        bill_id     TEXT NOT NULL UNIQUE REFERENCES bills(id),
        customer_id TEXT REFERENCES customers(id),
        overall     INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
        food        INTEGER CHECK (food IS NULL OR food BETWEEN 1 AND 5),
        service     INTEGER CHECK (service IS NULL OR service BETWEEN 1 AND 5),
        ambience    INTEGER CHECK (ambience IS NULL OR ambience BETWEEN 1 AND 5),
        comment     TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
        source      TEXT NOT NULL CHECK (source IN ('qr', 'staff')),
        created_at  INTEGER NOT NULL,
        created_by  TEXT REFERENCES users(id),
        CHECK ((source = 'staff') = (created_by IS NOT NULL))
      );
      CREATE INDEX idx_customer_feedback_created ON customer_feedback(created_at);
      CREATE INDEX idx_customer_feedback_customer ON customer_feedback(customer_id) WHERE customer_id IS NOT NULL;
    `);
  },
};
