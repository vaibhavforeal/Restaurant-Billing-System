import type { Migration } from "../migrate.js";

/**
 * Cash drawer shifts and day close. A cashier opens a shift with a float, records pay-ins and pay-outs, and closes it
 * by counting the drawer; expected cash and the variance are saved at close. A shift is written once at open and once at
 * close, then never changes. `day_closes` records an admin closing a business date, with the day-end report saved as it
 * was at that moment.
 */
export const migration035: Migration = {
  version: 35,
  name: "shifts-and-day-close",
  up(db) {
    db.exec(`
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
      CREATE UNIQUE INDEX idx_shifts_one_open ON shifts(cashier_id) WHERE closed_at IS NULL;
      CREATE INDEX idx_shifts_opened ON shifts(opened_at);
      CREATE TRIGGER shifts_closed_final BEFORE UPDATE ON shifts WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a closed shift cannot change'); END;
      CREATE TRIGGER shifts_no_delete BEFORE DELETE ON shifts BEGIN SELECT RAISE(ABORT, 'shift history is append-only'); END;

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
      CREATE INDEX idx_cash_movements_shift ON cash_movements(shift_id);
      CREATE TRIGGER cash_movements_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;
      CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;

      CREATE TABLE day_closes (
        business_date TEXT PRIMARY KEY CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        closed_at     INTEGER NOT NULL,
        closed_by     TEXT NOT NULL REFERENCES users(id),
        note          TEXT,
        report_json   TEXT NOT NULL,
        client_ref    TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER day_closes_no_update BEFORE UPDATE ON day_closes BEGIN SELECT RAISE(ABORT, 'a closed day cannot change'); END;
      CREATE TRIGGER day_closes_no_delete BEFORE DELETE ON day_closes BEGIN SELECT RAISE(ABORT, 'a closed day cannot change'); END;
    `);
  },
};
