import type { Migration } from "../migrate.js";

const ORDER_COLUMNS = [
  "id", "client_ref", "type", "table_id", "status", "opened_by", "opened_at", "closed_at", "split_label", "price_tier",
  "cancelled_by", "cancel_reason", "captain_id", "captain_name", "merged_into",
].join(", ");

const PAYMENT_COLUMNS = ["id", "bill_id", "mode", "amount_paise", "ref_note", "created_at"].join(", ");

interface ForeignKeyViolation { table: string; rowid: number | null; parent: string; fkid: number }
const violationKey = (v: ForeignKeyViolation) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid]);

/**
 * Zomato desk: widen the `orders.type`, `orders.price_tier` and `payments.mode` CHECKs to
 * allow `zomato`, add the Zomato order ID and status, and add a Zomato price to the menu.
 *
 * SQLite can't ALTER a CHECK, so `orders` and `payments` are rebuilt with the 004 pattern.
 * Column order and defaults match the v26 tables (001 plus the columns 003/016/017/018/024 added);
 * the new columns go last, and each row keeps its rowid. Every child FK says `REFERENCES orders(id)`
 * and none has an ON DELETE action, so with deferred foreign keys the implicit DELETE inside DROP TABLE
 * removes no child row. Nothing references `payments`, and no views or triggers sit on either table.
 *
 * Integrity rests on the final `foreign_key_check`, not on the deferred counter: it must find no
 * violation that was not already there before the rebuild. Older orphans elsewhere in the database
 * (left by a past release with foreign keys off) are not this migration's to fix and must not stop
 * the restaurant from starting; any link the rebuild breaks fails the migration and rolls it back.
 */
export const migration027: Migration = {
  version: 27,
  name: "zomato-desk",
  up(db) {
    const originalDefer = db.pragma("defer_foreign_keys", { simple: true }) as number;
    const existing = new Set((db.pragma("foreign_key_check") as ForeignKeyViolation[]).map(violationKey));
    db.pragma("defer_foreign_keys = 1");

    try {
      db.exec(`
        CREATE TABLE orders_new (
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
          zomato_status   TEXT CHECK (zomato_status IN ('preparing','ready','picked_up')),
          CHECK ((type = 'zomato') = (zomato_order_id IS NOT NULL))
        );
        INSERT INTO orders_new (rowid, ${ORDER_COLUMNS}) SELECT rowid, ${ORDER_COLUMNS} FROM orders;
        DROP TABLE orders;
        ALTER TABLE orders_new RENAME TO orders;
        CREATE INDEX idx_orders_status ON orders(status);
        CREATE INDEX idx_orders_table ON orders(table_id);
        CREATE UNIQUE INDEX orders_zomato_order_id ON orders(zomato_order_id) WHERE type = 'zomato';

        CREATE TABLE payments_new (
          id           TEXT PRIMARY KEY,
          bill_id      TEXT NOT NULL REFERENCES bills(id),
          mode         TEXT NOT NULL CHECK (mode IN ('cash','upi','card','zomato')),
          amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
          ref_note     TEXT,
          created_at   INTEGER NOT NULL
        );
        INSERT INTO payments_new (rowid, ${PAYMENT_COLUMNS}) SELECT rowid, ${PAYMENT_COLUMNS} FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_new RENAME TO payments;
        CREATE INDEX idx_payments_bill ON payments(bill_id);
        CREATE INDEX idx_payments_created ON payments(created_at);
      `);

      for (const table of ["products", "variants"]) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN zomato_price_paise INTEGER
          CHECK (zomato_price_paise IS NULL OR (typeof(zomato_price_paise) = 'integer' AND zomato_price_paise >= 0))`);
      }

      // Rowids are kept by the copy, so a violation present before the rebuild has the same key after it.
      const violations = (db.pragma("foreign_key_check") as ForeignKeyViolation[]).filter((v) => !existing.has(violationKey(v)));
      if (violations.length > 0) {
        throw new Error(`migration 027: foreign_key_check failed: ${JSON.stringify(violations.slice(0, 5))}`);
      }
    } finally {
      db.pragma(`defer_foreign_keys = ${originalDefer}`);
    }
  },
};
