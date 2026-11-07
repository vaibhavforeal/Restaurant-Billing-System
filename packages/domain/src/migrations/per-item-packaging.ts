import type { Migration } from "../migrate.js";

const PACKAGING_RANGE = "BETWEEN 0 AND 100000";

/**
 * Per-item packaging: the Bill settings toggle, a packaging amount on products and variants (variant NULL = the
 * product's), each bill line's packaging, and the charge amount each credit note credited (backfilled: every earlier
 * charge credit was the whole charge).
 */
export const perItemPackaging: Migration = {
  version: 61,
  name: "per_item_packaging",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN packaging_per_item INTEGER NOT NULL DEFAULT 0 CHECK (packaging_per_item IN (0, 1));
      ALTER TABLE products ADD COLUMN packaging_paise INTEGER NOT NULL DEFAULT 0 CHECK (packaging_paise ${PACKAGING_RANGE});
      ALTER TABLE variants ADD COLUMN packaging_paise INTEGER CHECK (packaging_paise IS NULL OR packaging_paise ${PACKAGING_RANGE});
      ALTER TABLE bill_report_lines ADD COLUMN packaging_paise INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE credit_note_charges ADD COLUMN amount_paise INTEGER NOT NULL DEFAULT 0;

      DROP TRIGGER credit_note_charges_no_update;
      UPDATE credit_note_charges SET amount_paise = COALESCE((
        SELECT bc.amount_paise FROM bill_charges bc JOIN credit_notes c ON c.bill_id = bc.bill_id
        WHERE c.id = credit_note_charges.credit_note_id AND bc.kind = credit_note_charges.kind
      ), 0);
      CREATE TRIGGER credit_note_charges_no_update BEFORE UPDATE ON credit_note_charges BEGIN SELECT RAISE(ABORT, 'credit note charges are immutable'); END;
    `);
  },
};
