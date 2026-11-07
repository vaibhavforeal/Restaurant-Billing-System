import type { Migration } from "../migrate.js";

/** A charge can carry part of the bill's round-off, for a bill whose items were all discounted to nothing. */
export const billChargeRounding: Migration = {
  version: 60,
  name: "bill_charge_rounding",
  up(db) {
    db.exec(`
      ALTER TABLE bill_charges ADD COLUMN rounding_paise INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE credit_note_charges ADD COLUMN rounding_paise INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
