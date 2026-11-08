import type { Migration } from "../migrate.js";

/**
 * A stored date is `YYYY-MM-DD` and a real calendar day. `date()` rolls 2026-02-30 over to March, so it no longer matches, and
 * returns NULL for a month 13 or a day 32; `IS` (not `=`) makes that NULL a mismatch, as a CHECK would let NULL through.
 */
const dateCheck = (column: string) => `CHECK (${column} IS NULL OR (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) IS ${column}))`;

/**
 * Offers: "buy X get Y" deals, item discounts and bill discounts the till applies by itself. The CHECKs mirror the
 * `OfferInput` schema in `offers.ts`. How many targets an offer needs depends on its kind (at least one for `buy_get`
 * and `item_off`, none for `bill_off`) and lives in another table, so the API enforces it. A bill keeps each applied
 * offer's name and amount, and where on its lines the money went, so editing an offer never changes an issued bill; like
 * `bill_charges`, those two tables are immutable once written.
 * `days_mask` holds the days it runs: bit i is weekday i, 0 = Monday to 6 = Sunday.
 */
export const offers: Migration = {
  version: 63,
  name: "offers",
  up(db) {
    db.exec(`
      CREATE TABLE offers (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
        active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        kind                TEXT NOT NULL CHECK (kind IN ('buy_get', 'item_off', 'bill_off')),
        buy_qty             INTEGER CHECK (buy_qty BETWEEN 1 AND 20),
        get_qty             INTEGER CHECK (get_qty BETWEEN 1 AND 20),
        same_item_only      INTEGER NOT NULL DEFAULT 0 CHECK (same_item_only IN (0, 1)),
        percent_bp          INTEGER CHECK (percent_bp BETWEEN 1 AND 10000),
        amount_paise        INTEGER CHECK (amount_paise > 0),
        min_bill_paise      INTEGER NOT NULL DEFAULT 0 CHECK (min_bill_paise >= 0),
        max_discount_paise  INTEGER CHECK (max_discount_paise > 0),
        valid_from          TEXT ${dateCheck("valid_from")},
        valid_until         TEXT ${dateCheck("valid_until")},
        days_mask           INTEGER NOT NULL DEFAULT 127 CHECK (days_mask BETWEEN 1 AND 127),
        time_from           INTEGER CHECK (time_from BETWEEN 0 AND 1439),
        time_until          INTEGER CHECK (time_until BETWEEN 0 AND 1439),
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        -- buy_get: both quantities and a percent, never an amount. Every other kind: no quantities, and a percent or an amount, not both.
        CHECK (kind = 'buy_get' OR (buy_qty IS NULL AND get_qty IS NULL AND (percent_bp IS NULL) != (amount_paise IS NULL))),
        CHECK (kind != 'buy_get' OR (buy_qty IS NOT NULL AND get_qty IS NOT NULL AND percent_bp IS NOT NULL AND amount_paise IS NULL)),
        CHECK (kind = 'buy_get' OR same_item_only = 0),
        CHECK (kind = 'bill_off' OR min_bill_paise = 0),
        CHECK (max_discount_paise IS NULL OR (kind = 'bill_off' AND percent_bp IS NOT NULL)),
        CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
        CHECK ((time_from IS NULL AND time_until IS NULL) OR (time_from IS NOT NULL AND time_until IS NOT NULL AND time_from != time_until))
      );

      CREATE TABLE offer_targets (
        offer_id     TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        category_id  TEXT REFERENCES categories(id),
        product_id   TEXT REFERENCES products(id),
        CHECK ((category_id IS NULL) != (product_id IS NULL))
      );
      CREATE UNIQUE INDEX idx_offer_targets_unique ON offer_targets(offer_id, COALESCE(category_id, ''), COALESCE(product_id, ''));

      CREATE TABLE offer_order_types (
        offer_id       TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        order_type_id  TEXT NOT NULL REFERENCES order_types(id),
        PRIMARY KEY (offer_id, order_type_id)
      );

      ALTER TABLE bills ADD COLUMN offer_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (offer_discount_paise >= 0);

      CREATE TABLE bill_offers (
        bill_id         TEXT NOT NULL REFERENCES bills(id),
        offer_id        TEXT NOT NULL REFERENCES offers(id),
        name            TEXT NOT NULL,
        discount_paise  INTEGER NOT NULL CHECK (discount_paise > 0),
        PRIMARY KEY (bill_id, offer_id)
      );
      CREATE TRIGGER bill_offers_no_update BEFORE UPDATE ON bill_offers BEGIN SELECT RAISE(ABORT, 'bill offers are immutable'); END;
      CREATE TRIGGER bill_offers_no_delete BEFORE DELETE ON bill_offers BEGIN SELECT RAISE(ABORT, 'bill offers are immutable'); END;

      CREATE TABLE bill_offer_lines (
        bill_id         TEXT NOT NULL REFERENCES bills(id),
        order_item_id   TEXT NOT NULL REFERENCES order_items(id),
        offer_id        TEXT NOT NULL REFERENCES offers(id),
        discount_paise  INTEGER NOT NULL CHECK (discount_paise > 0),
        PRIMARY KEY (bill_id, order_item_id, offer_id)
      );
      CREATE TRIGGER bill_offer_lines_no_update BEFORE UPDATE ON bill_offer_lines BEGIN SELECT RAISE(ABORT, 'bill offer lines are immutable'); END;
      CREATE TRIGGER bill_offer_lines_no_delete BEFORE DELETE ON bill_offer_lines BEGIN SELECT RAISE(ABORT, 'bill offer lines are immutable'); END;
    `);
  },
};
