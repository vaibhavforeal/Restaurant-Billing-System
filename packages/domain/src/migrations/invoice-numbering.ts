import type { Migration } from "../migrate.js";

/** Invoice numbering and round-off: a restaurant prefix, the bill round-off mode, and the printed invoice and credit note numbers. */
export const invoiceNumbering: Migration = {
  version: 57,
  name: "invoice_numbering",
  up(db) {
    // SQLite cannot ADD COLUMN ... UNIQUE, so unique indexes keep the printed numbers distinct (NULLs, from older bills, are allowed).
    db.exec(`
      ALTER TABLE settings ADD COLUMN invoice_prefix TEXT NOT NULL DEFAULT '' CHECK (length(invoice_prefix) <= 4);
      ALTER TABLE settings ADD COLUMN round_off TEXT NOT NULL DEFAULT 'rupee' CHECK (round_off IN ('rupee','half','off'));
      ALTER TABLE bills ADD COLUMN invoice_no TEXT;
      CREATE UNIQUE INDEX bills_invoice_no ON bills(invoice_no);
      ALTER TABLE credit_notes ADD COLUMN credit_note_ref TEXT;
      CREATE UNIQUE INDEX credit_notes_ref ON credit_notes(credit_note_ref);
    `);
  },
};
