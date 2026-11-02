import type { Migration } from "../migrate.js";
import { uuidv7 } from "../id.js";

/**
 * The whole POS schema as of version 43, in one step. MasalaPOS had not shipped when its first 43 migrations were folded
 * into this baseline, so no installation needs the steps in between: a new database is created here, and a database already at
 * version 43 skips it. A database at an earlier, pre-release version is refused by migrate() (start it afresh). Money is
 * INTEGER paise and timestamps INTEGER Unix ms written by app code; table status is derived from orders. New changes go in
 * migrations numbered from 44.
 */
export const baseline: Migration = {
  version: 43,
  name: "baseline",
  baseline: true,
  up(db) {
    db.exec(`
      CREATE TABLE users (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          pin_hash    TEXT NOT NULL,
          role        TEXT NOT NULL CHECK (role IN ('admin','cashier','waiter','kitchen')),
          is_active   INTEGER NOT NULL DEFAULT 1,
          created_at  INTEGER NOT NULL
        , max_discount_percent REAL CHECK (max_discount_percent IS NULL OR (max_discount_percent >= 0 AND max_discount_percent <= 100)));

      CREATE TABLE sessions (
          token       TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id),
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          device      TEXT
        );

      CREATE TABLE settings (
          id               INTEGER PRIMARY KEY CHECK (id = 1),
          restaurant_name  TEXT NOT NULL DEFAULT '',
          address          TEXT NOT NULL DEFAULT '',
          gstin            TEXT NOT NULL DEFAULT '',
          fssai            TEXT NOT NULL DEFAULT '',
          receipt_footer   TEXT NOT NULL DEFAULT '',
          setup_complete   INTEGER NOT NULL DEFAULT 0
        , upi_id TEXT NOT NULL DEFAULT '', require_kitchen_acceptance INTEGER NOT NULL DEFAULT 1, receipt_style TEXT NOT NULL DEFAULT 'classic' CHECK (receipt_style IN ('classic', 'modern', 'heritage', 'compact')), gst_mode TEXT NOT NULL DEFAULT 'included' CHECK (gst_mode IN ('included', 'none')), gst_rate INTEGER NOT NULL DEFAULT 5 CHECK (gst_rate IN (5, 12, 18)), kot_edit_print TEXT NOT NULL DEFAULT 'ask' CHECK (kot_edit_print IN ('ask', 'always', 'never')), update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'patch')), remote_support_enabled INTEGER NOT NULL DEFAULT 1 CHECK (remote_support_enabled IN (0, 1)));

      CREATE TABLE kot_stations (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          printer_id  TEXT REFERENCES printers(id),
          is_active   INTEGER NOT NULL DEFAULT 1
        );

      CREATE TABLE categories (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          is_active   INTEGER NOT NULL DEFAULT 1
        );

      CREATE TABLE products (
          id              TEXT PRIMARY KEY,
          category_id     TEXT NOT NULL REFERENCES categories(id),
          name            TEXT NOT NULL,
          price_paise     INTEGER NOT NULL CHECK (price_paise >= 0),
          is_veg          INTEGER NOT NULL DEFAULT 1,
          kot_station_id  TEXT REFERENCES kot_stations(id),
          is_active       INTEGER NOT NULL DEFAULT 1,
          created_at      INTEGER NOT NULL
        , stock_version INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1)), photo_data TEXT, photo_hash TEXT, ac_price_paise INTEGER CHECK (ac_price_paise IS NULL OR (typeof(ac_price_paise) = 'integer' AND ac_price_paise >= 0)), takeaway_price_paise INTEGER CHECK (takeaway_price_paise IS NULL OR (typeof(takeaway_price_paise) = 'integer' AND takeaway_price_paise >= 0)), zomato_price_paise INTEGER
            CHECK (zomato_price_paise IS NULL OR (typeof(zomato_price_paise) = 'integer' AND zomato_price_paise >= 0)), gst_rate REAL CHECK (gst_rate IS NULL OR gst_rate IN (0, 5, 12, 18, 28)), kind TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'combo')));

      CREATE TABLE variants (
          id           TEXT PRIMARY KEY,
          product_id   TEXT NOT NULL REFERENCES products(id),
          name         TEXT NOT NULL,
          price_paise  INTEGER NOT NULL CHECK (price_paise >= 0),
          is_active    INTEGER NOT NULL DEFAULT 1
        , ac_price_paise INTEGER CHECK (ac_price_paise IS NULL OR (typeof(ac_price_paise) = 'integer' AND ac_price_paise >= 0)), takeaway_price_paise INTEGER CHECK (takeaway_price_paise IS NULL OR (typeof(takeaway_price_paise) = 'integer' AND takeaway_price_paise >= 0)), zomato_price_paise INTEGER
            CHECK (zomato_price_paise IS NULL OR (typeof(zomato_price_paise) = 'integer' AND zomato_price_paise >= 0)));

      CREATE TABLE dining_tables (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          area        TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          is_active   INTEGER NOT NULL DEFAULT 1
        , price_tier TEXT NOT NULL DEFAULT 'non_ac' CHECK (price_tier IN ('non_ac', 'ac')));

      CREATE TABLE kots (
          id          TEXT PRIMARY KEY,
          order_id    TEXT NOT NULL REFERENCES orders(id),
          kot_no      INTEGER NOT NULL,
          station_id  TEXT NOT NULL REFERENCES kot_stations(id),
          created_at  INTEGER NOT NULL,
          created_by  TEXT NOT NULL REFERENCES users(id)
        , done_at INTEGER, accepted_at INTEGER);

      CREATE TABLE order_items (
          id                   TEXT PRIMARY KEY,
          order_id             TEXT NOT NULL REFERENCES orders(id),
          product_id           TEXT NOT NULL REFERENCES products(id),
          variant_id           TEXT REFERENCES variants(id),
          name_snapshot        TEXT NOT NULL,
          price_paise_snapshot INTEGER NOT NULL,
          gst_rate_snapshot    REAL NOT NULL,
          qty                  INTEGER NOT NULL CHECK (qty > 0),
          status               TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','sent','cancelled')),
          kot_id               TEXT REFERENCES kots(id),
          note                 TEXT,
          cancel_reason        TEXT,
          cancelled_by         TEXT REFERENCES users(id)
        , client_ref TEXT, guest_request_id TEXT REFERENCES guest_requests(id), cancelled_at INTEGER, parent_item_id TEXT REFERENCES order_items(id));

      CREATE TABLE bills (
          id              TEXT PRIMARY KEY,
          bill_no         INTEGER NOT NULL UNIQUE,
          order_id        TEXT NOT NULL UNIQUE REFERENCES orders(id),
          subtotal_paise  INTEGER NOT NULL,
          discount_paise  INTEGER NOT NULL DEFAULT 0,
          discount_note   TEXT,
          cgst_paise      INTEGER NOT NULL,
          sgst_paise      INTEGER NOT NULL,
          rounding_paise  INTEGER NOT NULL DEFAULT 0,
          total_paise     INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'unpaid'
                          CHECK (status IN ('unpaid','paid','void')),
          void_reason     TEXT,
          created_at      INTEGER NOT NULL,
          created_by      TEXT NOT NULL REFERENCES users(id)
        , client_ref TEXT, request_json TEXT, receipt_json TEXT, discount_approved_by TEXT REFERENCES users(id), customer_id TEXT REFERENCES customers(id), customer_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (customer_discount_paise >= 0), points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (points_redeemed >= 0), points_value_paise INTEGER NOT NULL DEFAULT 0 CHECK (points_value_paise >= 0), feedback_token TEXT);

      CREATE TABLE bill_taxes (
          id             TEXT PRIMARY KEY,
          bill_id        TEXT NOT NULL REFERENCES bills(id),
          gst_rate       REAL NOT NULL,
          taxable_paise  INTEGER NOT NULL,
          cgst_paise     INTEGER NOT NULL,
          sgst_paise     INTEGER NOT NULL
        );

      CREATE TABLE stock_items (
          id                   TEXT PRIMARY KEY,
          name                 TEXT NOT NULL,
          unit                 TEXT NOT NULL CHECK (unit IN ('pcs','kg','g','L','ml')),
          qty                  REAL NOT NULL DEFAULT 0,
          low_stock_threshold  REAL,
          is_active            INTEGER NOT NULL DEFAULT 1
        , client_ref TEXT, request_json TEXT, version INTEGER NOT NULL DEFAULT 0, unit_cost_milli_paise INTEGER);

      CREATE TABLE product_stock_links (
          id             TEXT PRIMARY KEY,
          product_id     TEXT NOT NULL REFERENCES products(id),
          stock_item_id  TEXT NOT NULL REFERENCES stock_items(id),
          qty_per_sale   REAL NOT NULL DEFAULT 1,
          UNIQUE (product_id, stock_item_id)
        );

      CREATE TABLE stock_moves (
          id             TEXT PRIMARY KEY,
          stock_item_id  TEXT NOT NULL REFERENCES stock_items(id),
          delta          REAL NOT NULL,
          reason         TEXT NOT NULL
                         CHECK (reason IN ('sale','purchase','adjustment','wastage','cancel_reversal')),
          ref            TEXT,
          note           TEXT,
          created_at     INTEGER NOT NULL,
          created_by     TEXT REFERENCES users(id)
        , client_ref TEXT, request_json TEXT, order_item_id TEXT REFERENCES order_items(id), reversal_of TEXT REFERENCES stock_moves(id), balance_after REAL, cost_paise INTEGER, unit_cost_after INTEGER, partial_of TEXT REFERENCES stock_moves(id));

      CREATE TABLE sequences (
          name   TEXT PRIMARY KEY,
          value  INTEGER NOT NULL
        );

      CREATE TABLE "printers" (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          kind         TEXT NOT NULL CHECK (kind IN ('network','windows','bluetooth')),
          connection   TEXT NOT NULL,
          paper_width  INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
          is_active    INTEGER NOT NULL DEFAULT 1
        , receipt_profile TEXT NOT NULL DEFAULT '{"copies":1,"feedLines":3,"autoCut":true}', kot_profile TEXT NOT NULL DEFAULT '{"copies":1,"feedLines":3,"autoCut":true}');

      CREATE TABLE bill_settlements (
          bill_id TEXT PRIMARY KEY REFERENCES bills(id),
          client_ref TEXT NOT NULL UNIQUE,
          request_json TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL
        );

      CREATE TABLE kot_requests (
          client_ref TEXT PRIMARY KEY,
          order_id TEXT NOT NULL REFERENCES orders(id),
          user_id TEXT NOT NULL REFERENCES users(id),
          fingerprint TEXT NOT NULL,
          kot_ids TEXT NOT NULL
        );

      CREATE TABLE license_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          envelope TEXT,
          license_id TEXT,
          organization_id TEXT,
          outlet_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER NOT NULL DEFAULT 0
        );

      CREATE TABLE licensed_devices (
          id TEXT PRIMARY KEY,
          credential_hash TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        , last_seen_at INTEGER, version INTEGER NOT NULL DEFAULT 1);

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
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          reason TEXT,
          order_id TEXT REFERENCES orders(id),
          reviewed_at INTEGER,
          reviewed_by TEXT REFERENCES users(id),
          decision_json TEXT
        );

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

      CREATE TABLE license_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at INTEGER NOT NULL,
          actor_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('license_activated','device_registered','device_renamed','device_removed')),
          summary TEXT NOT NULL,
          revision INTEGER,
          device_id TEXT
        );

      CREATE TABLE print_jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          printer_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','printing','done','failed','unknown')),
          job_json TEXT NOT NULL,
          target_json TEXT NOT NULL,
          payload BLOB NOT NULL
        );

      CREATE TABLE print_queue_state (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL);

      CREATE TABLE bill_report_lines (
          bill_id TEXT NOT NULL REFERENCES bills(id), order_item_id TEXT NOT NULL REFERENCES order_items(id),
          product_id TEXT NOT NULL, variant_id TEXT, name TEXT NOT NULL, category_id TEXT, category_name TEXT NOT NULL,
          qty INTEGER NOT NULL, subtotal_paise INTEGER NOT NULL, discount_paise INTEGER NOT NULL,
          taxable_paise INTEGER NOT NULL, cgst_paise INTEGER NOT NULL, sgst_paise INTEGER NOT NULL,
          rounding_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL, parent_order_item_id TEXT,
          PRIMARY KEY (bill_id, order_item_id)
        );

      CREATE TABLE zomato_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), restaurant_id TEXT NOT NULL DEFAULT '',
          restaurant_name TEXT NOT NULL DEFAULT '', pos_id TEXT NOT NULL DEFAULT '',
          webhook_base_url TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          version INTEGER NOT NULL DEFAULT 1, last_event_at INTEGER
        , warn_minutes INTEGER NOT NULL DEFAULT 15 CHECK (warn_minutes BETWEEN 1 AND 240), late_minutes INTEGER NOT NULL DEFAULT 25 CHECK (late_minutes BETWEEN 1 AND 240));

      CREATE TABLE zomato_orders (
          restaurant_id TEXT NOT NULL, order_id TEXT NOT NULL, placed_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('received','confirmed','preparing','ready','picked_up','delivered','rejected','cancelled')),
          total_paise INTEGER NOT NULL CHECK(total_paise >= 0), payment_mode TEXT NOT NULL CHECK(payment_mode IN ('prepaid','cod','unknown')),
          items_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL CHECK(source IN ('import','webhook')),
          status_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, import_json TEXT,
          PRIMARY KEY (restaurant_id, order_id)
        );

      CREATE TABLE zomato_events (
          restaurant_id TEXT NOT NULL, event_id TEXT NOT NULL, order_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, payload_json TEXT NOT NULL, received_at INTEGER NOT NULL,
          PRIMARY KEY (restaurant_id, event_id)
        );

      CREATE TABLE zomato_settlements (
          restaurant_id TEXT NOT NULL, entry_id TEXT NOT NULL, order_id TEXT NOT NULL,
          reference TEXT NOT NULL, settlement_date TEXT NOT NULL,
          gross_paise INTEGER NOT NULL CHECK(gross_paise >= 0), deductions_paise INTEGER NOT NULL CHECK(deductions_paise >= 0),
          additions_paise INTEGER NOT NULL CHECK(additions_paise >= 0), paid_paise INTEGER NOT NULL,
          import_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (restaurant_id, entry_id)
        );

      CREATE TABLE zomato_imports (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, restaurant_id TEXT NOT NULL, added INTEGER NOT NULL,
          skipped INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
        );

      CREATE TABLE stock_cost_changes (
          id                   TEXT PRIMARY KEY,
          stock_item_id        TEXT NOT NULL REFERENCES stock_items(id),
          old_cost_milli_paise INTEGER,
          new_cost_milli_paise INTEGER NOT NULL CHECK (new_cost_milli_paise > 0),
          note                 TEXT NOT NULL,
          created_at           INTEGER NOT NULL,
          created_by           TEXT NOT NULL REFERENCES users(id),
          client_ref           TEXT UNIQUE,
          request_json         TEXT
        );

      CREATE TABLE table_links (
          id        TEXT PRIMARY KEY,
          table_id  TEXT NOT NULL REFERENCES dining_tables(id),
          order_id  TEXT NOT NULL REFERENCES orders(id),
          linked_at INTEGER NOT NULL,
          linked_by TEXT NOT NULL REFERENCES users(id)
        );

      CREATE TABLE order_table_events (
          id                  TEXT PRIMARY KEY,
          kind                TEXT NOT NULL CHECK (kind IN ('move','merge')),
          order_id            TEXT NOT NULL,
          target_order_id     TEXT,
          from_table_id       TEXT,
          to_table_id         TEXT,
          folded_captain_name TEXT,
          created_at          INTEGER NOT NULL,
          created_by          TEXT NOT NULL REFERENCES users(id),
          client_ref          TEXT NOT NULL UNIQUE,
          request_json        TEXT NOT NULL
        );

      CREATE TABLE credit_notes (
          id             TEXT PRIMARY KEY,
          cn_no          INTEGER NOT NULL UNIQUE,
          bill_id        TEXT NOT NULL REFERENCES bills(id),
          kind           TEXT NOT NULL CHECK (kind IN ('void','refund')),
          reason         TEXT NOT NULL,
          taxable_paise  INTEGER NOT NULL,
          cgst_paise     INTEGER NOT NULL,
          sgst_paise     INTEGER NOT NULL,
          rounding_paise INTEGER NOT NULL,
          total_paise    INTEGER NOT NULL,
          requested_by   TEXT NOT NULL REFERENCES users(id),
          approved_by    TEXT NOT NULL REFERENCES users(id),
          created_at     INTEGER NOT NULL,
          client_ref     TEXT NOT NULL UNIQUE,
          request_json   TEXT NOT NULL
        );

      CREATE TABLE credit_note_lines (
          credit_note_id TEXT NOT NULL REFERENCES credit_notes(id),
          order_item_id  TEXT NOT NULL REFERENCES order_items(id),
          name           TEXT NOT NULL,
          category_id    TEXT,
          category_name  TEXT NOT NULL,
          gst_rate       REAL NOT NULL,
          qty            INTEGER NOT NULL CHECK (qty > 0),
          taxable_paise  INTEGER NOT NULL,
          cgst_paise     INTEGER NOT NULL,
          sgst_paise     INTEGER NOT NULL,
          rounding_paise INTEGER NOT NULL,
          total_paise    INTEGER NOT NULL,
          PRIMARY KEY (credit_note_id, order_item_id)
        );

      CREATE TABLE credit_note_taxes (
          credit_note_id TEXT NOT NULL REFERENCES credit_notes(id),
          gst_rate       REAL NOT NULL,
          taxable_paise  INTEGER NOT NULL,
          cgst_paise     INTEGER NOT NULL,
          sgst_paise     INTEGER NOT NULL,
          PRIMARY KEY (credit_note_id, gst_rate)
        );

      CREATE TABLE refund_payments (
          id             TEXT PRIMARY KEY,
          credit_note_id TEXT NOT NULL REFERENCES credit_notes(id),
          mode           TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
          amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
          ref_note       TEXT,
          created_at     INTEGER NOT NULL
        );

      CREATE TABLE integration_state (
          id         TEXT PRIMARY KEY,
          enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          updated_at INTEGER NOT NULL,
          updated_by TEXT NOT NULL REFERENCES users(id)
        );

      CREATE TABLE "orders" (
          id              TEXT PRIMARY KEY,
          client_ref      TEXT NOT NULL UNIQUE,
          type            TEXT NOT NULL CHECK (type IN ('dine_in','parcel','zomato')),
          table_id        TEXT REFERENCES dining_tables(id),
          status          TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','billed','settled','cancelled')),
          opened_by       TEXT NOT NULL REFERENCES users(id),
          opened_at       INTEGER NOT NULL,
          closed_at       INTEGER,
          split_label     TEXT,
          price_tier      TEXT NOT NULL DEFAULT 'non_ac' CHECK (price_tier IN ('non_ac','ac','takeaway','zomato')),
          cancelled_by    TEXT REFERENCES users(id),
          cancel_reason   TEXT,
          captain_id      TEXT REFERENCES users(id),
          captain_name    TEXT,
          merged_into     TEXT REFERENCES orders(id),
          zomato_order_id TEXT,
          zomato_status   TEXT CHECK (zomato_status IN ('preparing','ready','picked_up')), order_type_id TEXT REFERENCES order_types(id), order_type_name TEXT, customer_id TEXT REFERENCES customers(id),
          CHECK ((type = 'zomato') = (zomato_order_id IS NOT NULL))
        );

      CREATE TABLE "payments" (
          id           TEXT PRIMARY KEY,
          bill_id      TEXT NOT NULL REFERENCES bills(id),
          mode         TEXT NOT NULL CHECK (mode IN ('cash','upi','card','zomato')),
          amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
          ref_note     TEXT,
          created_at   INTEGER NOT NULL
        );

      CREATE TABLE discount_caps (
          role TEXT PRIMARY KEY CHECK (role IN ('admin', 'cashier', 'waiter', 'kitchen')),
          max_percent REAL CHECK (max_percent IS NULL OR (max_percent >= 0 AND max_percent <= 100))
        );

      CREATE TABLE kot_edits (
          id                TEXT PRIMARY KEY,
          order_item_id     TEXT NOT NULL REFERENCES order_items(id),
          order_id          TEXT NOT NULL REFERENCES orders(id),
          kot_id            TEXT REFERENCES kots(id),
          old_qty           INTEGER NOT NULL,
          new_qty           INTEGER NOT NULL CHECK (new_qty > 0 AND new_qty <= old_qty),
          old_note          TEXT,
          new_note          TEXT,
          reason            TEXT,
          cancelled_item_id TEXT REFERENCES order_items(id),
          printed           INTEGER NOT NULL CHECK (printed IN (0, 1)),
          created_at        INTEGER NOT NULL,
          created_by        TEXT NOT NULL REFERENCES users(id),
          client_ref        TEXT NOT NULL UNIQUE,
          request_json      TEXT NOT NULL
        );

      CREATE TABLE order_types (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
          kind       TEXT NOT NULL CHECK (kind IN ('dine_in', 'takeaway', 'delivery', 'aggregator')),
          is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

      CREATE TABLE shifts (
          id                  TEXT PRIMARY KEY,
          cashier_id          TEXT NOT NULL REFERENCES users(id),
          opened_at           INTEGER NOT NULL,
          opening_float_paise INTEGER NOT NULL CHECK (opening_float_paise >= 0),
          open_client_ref     TEXT NOT NULL UNIQUE,
          closed_at           INTEGER,
          closed_by           TEXT REFERENCES users(id),
          counted_cash_paise  INTEGER CHECK (counted_cash_paise IS NULL OR counted_cash_paise >= 0),
          expected_cash_paise INTEGER,
          variance_paise      INTEGER,
          close_note          TEXT,
          close_client_ref    TEXT UNIQUE,
          CHECK ((closed_at IS NULL) = (counted_cash_paise IS NULL)),
          CHECK ((closed_at IS NULL) = (expected_cash_paise IS NULL))
        );

      CREATE TABLE cash_movements (
          id           TEXT PRIMARY KEY,
          shift_id     TEXT NOT NULL REFERENCES shifts(id),
          kind         TEXT NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
          amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
          reason       TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          created_by   TEXT NOT NULL REFERENCES users(id),
          client_ref   TEXT NOT NULL UNIQUE,
          request_json TEXT NOT NULL
        );

      CREATE TABLE day_closes (
          business_date TEXT PRIMARY KEY CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          closed_at     INTEGER NOT NULL,
          closed_by     TEXT NOT NULL REFERENCES users(id),
          note          TEXT,
          report_json   TEXT NOT NULL,
          client_ref    TEXT NOT NULL UNIQUE
        );

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

      CREATE TABLE customers (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
          phone      TEXT NOT NULL UNIQUE CHECK (phone GLOB '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
          type_id    TEXT REFERENCES customer_types(id),
          notes      TEXT,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id)
        , email TEXT CHECK (email IS NULL OR email LIKE '%_@_%'), birth_date TEXT CHECK (birth_date IS NULL OR birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR birth_date GLOB '--[0-1][0-9]-[0-3][0-9]'), anniversary_date TEXT CHECK (anniversary_date IS NULL OR anniversary_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' OR anniversary_date GLOB '--[0-1][0-9]-[0-3][0-9]'), gender TEXT CHECK (gender IS NULL OR gender IN ('female', 'male', 'other')), marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)), updated_at INTEGER);

      CREATE TABLE loyalty_settings (
          id                  INTEGER PRIMARY KEY CHECK (id = 1),
          enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          points_per_100      INTEGER NOT NULL DEFAULT 1 CHECK (points_per_100 BETWEEN 1 AND 100),
          point_value_paise   INTEGER NOT NULL DEFAULT 100 CHECK (point_value_paise BETWEEN 1 AND 10000),
          min_redeem_points   INTEGER NOT NULL DEFAULT 0 CHECK (min_redeem_points >= 0)
        , expiry_months INTEGER NOT NULL DEFAULT 0 CHECK (expiry_months BETWEEN 0 AND 120), tiers_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tiers_enabled IN (0, 1)), tier_window_months INTEGER NOT NULL DEFAULT 12 CHECK (tier_window_months BETWEEN 1 AND 60), max_redeem_percent INTEGER NOT NULL DEFAULT 100 CHECK (max_redeem_percent BETWEEN 1 AND 100), feedback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (feedback_enabled IN (0, 1)));

      CREATE TABLE saved_reports (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
          config_json TEXT NOT NULL CHECK (json_valid(config_json)),
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          created_by  TEXT NOT NULL REFERENCES users(id)
        );

      CREATE TABLE customer_tags (
          customer_id TEXT NOT NULL REFERENCES customers(id),
          tag         TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0),
          PRIMARY KEY (customer_id, tag)
        );

      CREATE TABLE "loyalty_ledger" (
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

      CREATE TABLE user_permissions (
          user_id    TEXT NOT NULL REFERENCES users(id),
          permission TEXT NOT NULL CHECK (permission GLOB '[a-z]*.[a-z_]*' AND permission NOT IN ('users.manage', 'settings.manage')),
          allowed    INTEGER NOT NULL CHECK (allowed IN (0, 1)),
          updated_at INTEGER NOT NULL,
          updated_by TEXT NOT NULL REFERENCES users(id),
          PRIMARY KEY (user_id, permission)
        );

      CREATE TABLE combo_groups (
          id          TEXT PRIMARY KEY,
          combo_id    TEXT NOT NULL REFERENCES products(id),
          name        TEXT NOT NULL,
          min_picks   INTEGER NOT NULL CHECK (min_picks >= 0),
          max_picks   INTEGER NOT NULL CHECK (max_picks >= 1 AND max_picks >= min_picks),
          sort_order  INTEGER NOT NULL
        );

      CREATE TABLE combo_options (
          id                 TEXT PRIMARY KEY,
          group_id           TEXT NOT NULL REFERENCES combo_groups(id),
          product_id         TEXT NOT NULL REFERENCES products(id),
          variant_id         TEXT REFERENCES variants(id),
          qty                INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
          extra_price_paise  INTEGER NOT NULL DEFAULT 0 CHECK (extra_price_paise >= 0),
          sort_order         INTEGER NOT NULL
        );

      CREATE TABLE remote_support_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT NOT NULL,
          at          INTEGER NOT NULL,
          event       TEXT NOT NULL CHECK (event IN ('requested', 'allowed', 'refused', 'started', 'ended')),
          agent_name  TEXT,
          actor_name  TEXT,
          detail      TEXT
        );

      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE INDEX idx_kots_order ON kots(order_id);

      CREATE INDEX idx_order_items_order ON order_items(order_id);

      CREATE INDEX idx_bill_taxes_bill ON bill_taxes(bill_id);

      CREATE INDEX idx_stock_moves_item ON stock_moves(stock_item_id);

      CREATE UNIQUE INDEX idx_order_items_client_ref
        ON order_items(client_ref) WHERE client_ref IS NOT NULL;

      CREATE UNIQUE INDEX idx_bills_client_ref ON bills(client_ref) WHERE client_ref IS NOT NULL;

      CREATE INDEX idx_bills_created ON bills(created_at);

      CREATE UNIQUE INDEX idx_stock_items_ref ON stock_items(client_ref) WHERE client_ref IS NOT NULL;

      CREATE UNIQUE INDEX idx_stock_moves_ref ON stock_moves(client_ref) WHERE client_ref IS NOT NULL;

      CREATE UNIQUE INDEX idx_stock_sale_item ON stock_moves(order_item_id, stock_item_id) WHERE reason = 'sale' AND order_item_id IS NOT NULL;

      CREATE UNIQUE INDEX idx_stock_reversal ON stock_moves(reversal_of) WHERE reversal_of IS NOT NULL;

      CREATE INDEX idx_stock_moves_order_item ON stock_moves(order_item_id);

      CREATE INDEX idx_stock_moves_history ON stock_moves(stock_item_id, id);

      CREATE INDEX idx_licensed_devices_active ON licensed_devices(revoked_at, created_at);

      CREATE INDEX idx_guest_pending ON guest_requests(status, table_id, expires_at);

      CREATE INDEX idx_order_items_guest_request ON order_items(guest_request_id);

      CREATE UNIQUE INDEX idx_guest_service_pending ON guest_service_requests(table_id, kind) WHERE status = 'pending';

      CREATE INDEX idx_guest_service_recent ON guest_service_requests(table_id, kind, created_at DESC);

      CREATE INDEX idx_guest_service_status ON guest_service_requests(status, created_at DESC);

      CREATE INDEX idx_reservations_table_time ON reservations(table_id, starts_at, ends_at);

      CREATE INDEX idx_reservations_schedule ON reservations(starts_at, status);

      CREATE INDEX print_jobs_pending ON print_jobs(printer_id, status, sequence);

      CREATE INDEX idx_order_items_cancelled ON order_items(cancelled_at) WHERE cancelled_at IS NOT NULL;

      CREATE INDEX idx_kots_created ON kots(created_at);

      CREATE INDEX idx_stock_moves_created ON stock_moves(created_at);

      CREATE INDEX zomato_orders_date ON zomato_orders(restaurant_id, placed_at);

      CREATE INDEX zomato_orders_status ON zomato_orders(restaurant_id, status);

      CREATE INDEX zomato_events_order ON zomato_events(restaurant_id, order_id, occurred_at);

      CREATE INDEX zomato_settlements_order ON zomato_settlements(restaurant_id, order_id);

      CREATE INDEX zomato_settlements_date ON zomato_settlements(restaurant_id, settlement_date);

      CREATE INDEX idx_stock_cost_changes_item ON stock_cost_changes(stock_item_id, created_at);

      CREATE INDEX idx_table_links_table ON table_links(table_id);

      CREATE INDEX idx_table_links_order ON table_links(order_id);

      CREATE INDEX idx_credit_notes_bill ON credit_notes(bill_id);

      CREATE INDEX idx_credit_notes_created ON credit_notes(created_at);

      CREATE INDEX idx_refund_payments_note ON refund_payments(credit_note_id);

      CREATE INDEX idx_orders_status ON orders(status);

      CREATE INDEX idx_orders_table ON orders(table_id);

      CREATE UNIQUE INDEX orders_zomato_order_id ON orders(zomato_order_id) WHERE type = 'zomato';

      CREATE INDEX idx_payments_bill ON payments(bill_id);

      CREATE INDEX idx_payments_created ON payments(created_at);

      CREATE INDEX idx_stock_moves_partial ON stock_moves(partial_of) WHERE partial_of IS NOT NULL;

      CREATE INDEX idx_kot_edits_order ON kot_edits(order_id);

      CREATE INDEX idx_orders_order_type ON orders(order_type_id) WHERE order_type_id IS NOT NULL;

      CREATE UNIQUE INDEX idx_shifts_one_open ON shifts(cashier_id) WHERE closed_at IS NULL;

      CREATE INDEX idx_shifts_opened ON shifts(opened_at);

      CREATE INDEX idx_cash_movements_shift ON cash_movements(shift_id);

      CREATE INDEX idx_customer_type_slabs_type ON customer_type_slabs(type_id);

      CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);

      CREATE INDEX idx_bills_customer ON bills(customer_id) WHERE customer_id IS NOT NULL;

      CREATE INDEX idx_customer_tags_tag ON customer_tags(tag);

      CREATE INDEX idx_loyalty_customer ON loyalty_ledger(customer_id);

      CREATE INDEX idx_loyalty_bill ON loyalty_ledger(bill_id) WHERE bill_id IS NOT NULL;

      CREATE INDEX idx_loyalty_expiry ON loyalty_ledger(expires_at) WHERE expires_at IS NOT NULL;

      CREATE UNIQUE INDEX idx_bills_feedback_token ON bills(feedback_token) WHERE feedback_token IS NOT NULL;

      CREATE INDEX idx_customer_feedback_created ON customer_feedback(created_at);

      CREATE INDEX idx_customer_feedback_customer ON customer_feedback(customer_id) WHERE customer_id IS NOT NULL;

      CREATE INDEX idx_combo_groups_combo ON combo_groups(combo_id, sort_order);

      CREATE INDEX idx_combo_options_group ON combo_options(group_id, sort_order);

      CREATE INDEX idx_combo_options_product ON combo_options(product_id);

      CREATE INDEX idx_order_items_parent ON order_items(parent_item_id) WHERE parent_item_id IS NOT NULL;

      CREATE INDEX idx_remote_support_log_at ON remote_support_log(at);

      CREATE TRIGGER stock_moves_no_update BEFORE UPDATE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock history is append-only'); END;

      CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock history is append-only'); END;

      CREATE TRIGGER bill_report_lines_no_update BEFORE UPDATE ON bill_report_lines BEGIN SELECT RAISE(ABORT, 'bill report lines are immutable'); END;

      CREATE TRIGGER bill_report_lines_no_delete BEFORE DELETE ON bill_report_lines BEGIN SELECT RAISE(ABORT, 'bill report lines are immutable'); END;

      CREATE TRIGGER stock_cost_changes_no_update BEFORE UPDATE ON stock_cost_changes BEGIN SELECT RAISE(ABORT, 'stock cost history is append-only'); END;

      CREATE TRIGGER stock_cost_changes_no_delete BEFORE DELETE ON stock_cost_changes BEGIN SELECT RAISE(ABORT, 'stock cost history is append-only'); END;

      CREATE TRIGGER order_table_events_no_update BEFORE UPDATE ON order_table_events BEGIN SELECT RAISE(ABORT, 'table transfer history is append-only'); END;

      CREATE TRIGGER order_table_events_no_delete BEFORE DELETE ON order_table_events BEGIN SELECT RAISE(ABORT, 'table transfer history is append-only'); END;

      CREATE TRIGGER credit_notes_no_update BEFORE UPDATE ON credit_notes BEGIN SELECT RAISE(ABORT, 'credit notes are append-only'); END;

      CREATE TRIGGER credit_notes_no_delete BEFORE DELETE ON credit_notes BEGIN SELECT RAISE(ABORT, 'credit notes are append-only'); END;

      CREATE TRIGGER credit_note_lines_no_update BEFORE UPDATE ON credit_note_lines BEGIN SELECT RAISE(ABORT, 'credit note lines are append-only'); END;

      CREATE TRIGGER credit_note_lines_no_delete BEFORE DELETE ON credit_note_lines BEGIN SELECT RAISE(ABORT, 'credit note lines are append-only'); END;

      CREATE TRIGGER credit_note_taxes_no_update BEFORE UPDATE ON credit_note_taxes BEGIN SELECT RAISE(ABORT, 'credit note taxes are append-only'); END;

      CREATE TRIGGER credit_note_taxes_no_delete BEFORE DELETE ON credit_note_taxes BEGIN SELECT RAISE(ABORT, 'credit note taxes are append-only'); END;

      CREATE TRIGGER refund_payments_no_update BEFORE UPDATE ON refund_payments BEGIN SELECT RAISE(ABORT, 'refund payments are append-only'); END;

      CREATE TRIGGER refund_payments_no_delete BEFORE DELETE ON refund_payments BEGIN SELECT RAISE(ABORT, 'refund payments are append-only'); END;

      CREATE TRIGGER kot_edits_no_update BEFORE UPDATE ON kot_edits BEGIN SELECT RAISE(ABORT, 'KOT edit history is append-only'); END;

      CREATE TRIGGER kot_edits_no_delete BEFORE DELETE ON kot_edits BEGIN SELECT RAISE(ABORT, 'KOT edit history is append-only'); END;

      CREATE TRIGGER shifts_closed_final BEFORE UPDATE ON shifts WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a closed shift cannot change'); END;

      CREATE TRIGGER shifts_no_delete BEFORE DELETE ON shifts BEGIN SELECT RAISE(ABORT, 'shift history is append-only'); END;

      CREATE TRIGGER cash_movements_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;

      CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;

      CREATE TRIGGER day_closes_no_update BEFORE UPDATE ON day_closes BEGIN SELECT RAISE(ABORT, 'a closed day cannot change'); END;

      CREATE TRIGGER day_closes_no_delete BEFORE DELETE ON day_closes BEGIN SELECT RAISE(ABORT, 'a closed day cannot change'); END;

      CREATE TRIGGER loyalty_ledger_no_update BEFORE UPDATE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;

      CREATE TRIGGER loyalty_ledger_no_delete BEFORE DELETE ON loyalty_ledger BEGIN SELECT RAISE(ABORT, 'loyalty history is append-only'); END;
    `);
    db.exec(`
      INSERT INTO settings (id, restaurant_name, address, gstin, fssai, receipt_footer, setup_complete, upi_id, require_kitchen_acceptance, receipt_style, gst_mode, gst_rate, kot_edit_print, update_channel, remote_support_enabled) VALUES (1, '', '', '', '', '', 0, '', 1, 'classic', 'included', 5, 'ask', 'stable', 1);
      INSERT INTO sequences (name, value) VALUES ('bill_no', 0);
      INSERT INTO sequences (name, value) VALUES ('credit_note_no', 0);
      INSERT INTO license_state (id, envelope, license_id, organization_id, outlet_id, revision, last_seen_at) VALUES (1, NULL, NULL, NULL, NULL, 0, 0);
      INSERT INTO zomato_settings (id, restaurant_id, restaurant_name, pos_id, webhook_base_url, enabled, version, last_event_at, warn_minutes, late_minutes) VALUES (1, '', '', '', '', 0, 1, NULL, 15, 25);
      INSERT INTO discount_caps (role, max_percent) VALUES ('admin', NULL);
      INSERT INTO discount_caps (role, max_percent) VALUES ('cashier', 10);
      INSERT INTO discount_caps (role, max_percent) VALUES ('waiter', 0);
      INSERT INTO discount_caps (role, max_percent) VALUES ('kitchen', 0);
      INSERT INTO order_types (id, name, kind, is_active, is_system, sort_order, created_at) VALUES ('dine_in', 'Dine-in', 'dine_in', 1, 1, 0, 0);
      INSERT INTO order_types (id, name, kind, is_active, is_system, sort_order, created_at) VALUES ('parcel', 'Takeaway', 'takeaway', 1, 1, 1, 0);
      INSERT INTO order_types (id, name, kind, is_active, is_system, sort_order, created_at) VALUES ('zomato', 'Zomato', 'aggregator', 1, 1, 2, 0);
      INSERT INTO loyalty_settings (id, enabled, points_per_100, point_value_paise, min_redeem_points, expiry_months, tiers_enabled, tier_window_months, max_redeem_percent, feedback_enabled) VALUES (1, 0, 1, 100, 0, 0, 0, 12, 100, 0);
    `);
    // The default kitchen station; its id, like every other, is made at run time.
    db.prepare("INSERT INTO kot_stations (id, name, printer_id, is_active) VALUES (?, 'Kitchen', NULL, 1);").run(uuidv7());
  },
};
