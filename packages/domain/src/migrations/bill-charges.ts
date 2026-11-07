import type { Migration } from "../migrate.js";

const KIND_CHECK = "CHECK (kind IN ('service','packaging'))";

/** Service charge and packaging charge: the two settings, the per-bill charge lines and their credit-note counterparts. */
export const billCharges: Migration = {
  version: 59,
  name: "bill_charges",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN service_charge_bp INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_bp BETWEEN 0 AND 2000);
      ALTER TABLE settings ADD COLUMN packaging_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (packaging_charge_paise BETWEEN 0 AND 100000);
      ALTER TABLE settings ADD COLUMN service_charge_label TEXT NOT NULL DEFAULT 'Service charge';
      ALTER TABLE settings ADD COLUMN packaging_charge_label TEXT NOT NULL DEFAULT 'Packaging';
      ALTER TABLE bills ADD COLUMN charges_paise INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE bill_charges (
        bill_id TEXT NOT NULL REFERENCES bills(id),
        kind TEXT NOT NULL ${KIND_CHECK},
        label TEXT NOT NULL,
        percent_bp INTEGER,
        gst_rate INTEGER NOT NULL,
        amount_paise INTEGER NOT NULL,
        taxable_paise INTEGER NOT NULL,
        cgst_paise INTEGER NOT NULL,
        sgst_paise INTEGER NOT NULL,
        PRIMARY KEY (bill_id, kind)
      );
      CREATE TRIGGER bill_charges_no_update BEFORE UPDATE ON bill_charges BEGIN SELECT RAISE(ABORT, 'bill charges are immutable'); END;
      CREATE TRIGGER bill_charges_no_delete BEFORE DELETE ON bill_charges BEGIN SELECT RAISE(ABORT, 'bill charges are immutable'); END;

      CREATE TABLE credit_note_charges (
        credit_note_id TEXT NOT NULL REFERENCES credit_notes(id),
        kind TEXT NOT NULL ${KIND_CHECK},
        label TEXT NOT NULL,
        gst_rate INTEGER NOT NULL,
        taxable_paise INTEGER NOT NULL,
        cgst_paise INTEGER NOT NULL,
        sgst_paise INTEGER NOT NULL,
        total_paise INTEGER NOT NULL,
        PRIMARY KEY (credit_note_id, kind)
      );
      CREATE TRIGGER credit_note_charges_no_update BEFORE UPDATE ON credit_note_charges BEGIN SELECT RAISE(ABORT, 'credit note charges are immutable'); END;
      CREATE TRIGGER credit_note_charges_no_delete BEFORE DELETE ON credit_note_charges BEGIN SELECT RAISE(ABORT, 'credit note charges are immutable'); END;
    `);
  },
};
