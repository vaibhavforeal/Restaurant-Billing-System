import type { Migration } from "../migrate.js";
import { uuidv7 } from "../id.js";

/**
 * The entire POS schema, up front (spec §3). Money is INTEGER paise;
 * timestamps are INTEGER Unix ms written by app code. Table status is
 * derived from orders — deliberately no status column on dining_tables.
 */
export const migration001: Migration = {
  version: 1,
  name: "initial-schema",
  up(db) {
    db.exec(`
      CREATE TABLE users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        pin_hash    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('admin','cashier','waiter','kitchen')),
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        device      TEXT
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE settings (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        restaurant_name  TEXT NOT NULL DEFAULT '',
        address          TEXT NOT NULL DEFAULT '',
        gstin            TEXT NOT NULL DEFAULT '',
        fssai            TEXT NOT NULL DEFAULT '',
        receipt_footer   TEXT NOT NULL DEFAULT '',
        setup_complete   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE printers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('network','windows')),
        connection   TEXT NOT NULL,
        paper_width  INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
        is_active    INTEGER NOT NULL DEFAULT 1
      );

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
        gst_rate        REAL NOT NULL CHECK (gst_rate >= 0),
        is_veg          INTEGER NOT NULL DEFAULT 1,
        kot_station_id  TEXT REFERENCES kot_stations(id),
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE variants (
        id           TEXT PRIMARY KEY,
        product_id   TEXT NOT NULL REFERENCES products(id),
        name         TEXT NOT NULL,
        price_paise  INTEGER NOT NULL CHECK (price_paise >= 0),
        is_active    INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE dining_tables (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        area        TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        client_ref  TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL CHECK (type IN ('dine_in','parcel')),
        table_id    TEXT REFERENCES dining_tables(id),
        status      TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','billed','settled','cancelled')),
        opened_by   TEXT NOT NULL REFERENCES users(id),
        opened_at   INTEGER NOT NULL,
        closed_at   INTEGER
      );
      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_table ON orders(table_id);

      CREATE TABLE kots (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        kot_no      INTEGER NOT NULL,
        station_id  TEXT NOT NULL REFERENCES kot_stations(id),
        created_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_kots_order ON kots(order_id);

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
      );
      CREATE INDEX idx_order_items_order ON order_items(order_id);

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
      );

      CREATE TABLE bill_taxes (
        id             TEXT PRIMARY KEY,
        bill_id        TEXT NOT NULL REFERENCES bills(id),
        gst_rate       REAL NOT NULL,
        taxable_paise  INTEGER NOT NULL,
        cgst_paise     INTEGER NOT NULL,
        sgst_paise     INTEGER NOT NULL
      );
      CREATE INDEX idx_bill_taxes_bill ON bill_taxes(bill_id);

      CREATE TABLE payments (
        id           TEXT PRIMARY KEY,
        bill_id      TEXT NOT NULL REFERENCES bills(id),
        mode         TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        ref_note     TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_payments_bill ON payments(bill_id);

      CREATE TABLE stock_items (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        unit                 TEXT NOT NULL CHECK (unit IN ('pcs','kg','g','L','ml')),
        qty                  REAL NOT NULL DEFAULT 0,
        low_stock_threshold  REAL,
        is_active            INTEGER NOT NULL DEFAULT 1
      );

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
      );
      CREATE INDEX idx_stock_moves_item ON stock_moves(stock_item_id);

      CREATE TABLE sequences (
        name   TEXT PRIMARY KEY,
        value  INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO settings (id) VALUES (1)").run();
    db.prepare("INSERT INTO kot_stations (id, name) VALUES (?, 'Kitchen')").run(uuidv7());
    db.prepare("INSERT INTO sequences (name, value) VALUES ('bill_no', 0)").run();
  },
};
