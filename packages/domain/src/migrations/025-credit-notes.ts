import type { Migration } from "../migrate.js";

export const migration025: Migration = {
  version: 25,
  name: "credit-notes",
  up(db) {
    // Voids and refunds are credit notes: new append-only rows that offset an issued bill without ever editing it.
    // credit_notes.created_at is the date every report uses for the credit; client_ref makes retries idempotent.
    db.exec(`
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
      CREATE INDEX idx_credit_notes_bill ON credit_notes(bill_id);
      CREATE INDEX idx_credit_notes_created ON credit_notes(created_at);
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
      CREATE INDEX idx_refund_payments_note ON refund_payments(credit_note_id);
      CREATE TRIGGER credit_notes_no_update BEFORE UPDATE ON credit_notes BEGIN SELECT RAISE(ABORT, 'credit notes are append-only'); END;
      CREATE TRIGGER credit_notes_no_delete BEFORE DELETE ON credit_notes BEGIN SELECT RAISE(ABORT, 'credit notes are append-only'); END;
      CREATE TRIGGER credit_note_lines_no_update BEFORE UPDATE ON credit_note_lines BEGIN SELECT RAISE(ABORT, 'credit note lines are append-only'); END;
      CREATE TRIGGER credit_note_lines_no_delete BEFORE DELETE ON credit_note_lines BEGIN SELECT RAISE(ABORT, 'credit note lines are append-only'); END;
      CREATE TRIGGER credit_note_taxes_no_update BEFORE UPDATE ON credit_note_taxes BEGIN SELECT RAISE(ABORT, 'credit note taxes are append-only'); END;
      CREATE TRIGGER credit_note_taxes_no_delete BEFORE DELETE ON credit_note_taxes BEGIN SELECT RAISE(ABORT, 'credit note taxes are append-only'); END;
      CREATE TRIGGER refund_payments_no_update BEFORE UPDATE ON refund_payments BEGIN SELECT RAISE(ABORT, 'refund payments are append-only'); END;
      CREATE TRIGGER refund_payments_no_delete BEFORE DELETE ON refund_payments BEGIN SELECT RAISE(ABORT, 'refund payments are append-only'); END;
      INSERT INTO sequences (name, value) VALUES ('credit_note_no', 0);
    `);
  },
};
