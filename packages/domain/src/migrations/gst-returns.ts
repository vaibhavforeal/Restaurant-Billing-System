import type { Migration } from "../migrate.js";

/**
 * GST returns: the SAC code printed on tax invoices, Zomato's GSTIN for GSTR-1 Table 14, a business customer's GSTIN and
 * legal name, and the buyer a B2B bill was issued to. A bill's buyer is fixed once issued; a wrong buyer means void and re-bill.
 */
export const gstReturns: Migration = {
  version: 53,
  name: "gst_returns",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN sac_code TEXT NOT NULL DEFAULT '996331'
        CHECK (length(sac_code) BETWEEN 4 AND 8 AND sac_code NOT GLOB '*[^0-9]*');
      ALTER TABLE settings ADD COLUMN zomato_gstin TEXT NOT NULL DEFAULT '' CHECK (zomato_gstin = '' OR length(zomato_gstin) = 15);
      ALTER TABLE customers ADD COLUMN gstin TEXT CHECK (gstin IS NULL OR length(gstin) = 15);
      ALTER TABLE customers ADD COLUMN legal_name TEXT CHECK (legal_name IS NULL OR length(trim(legal_name)) BETWEEN 1 AND 100);
      ALTER TABLE bills ADD COLUMN buyer_gstin TEXT CHECK (buyer_gstin IS NULL OR length(buyer_gstin) = 15);
      ALTER TABLE bills ADD COLUMN buyer_name TEXT CHECK (buyer_name IS NULL OR length(trim(buyer_name)) BETWEEN 1 AND 100);
      ALTER TABLE bills ADD COLUMN buyer_address TEXT CHECK (buyer_address IS NULL OR length(buyer_address) <= 200);
      CREATE INDEX idx_bills_buyer_gstin ON bills(buyer_gstin) WHERE buyer_gstin IS NOT NULL;
      CREATE TRIGGER bills_buyer_immutable BEFORE UPDATE OF buyer_gstin, buyer_name, buyer_address ON bills
        WHEN OLD.buyer_gstin IS NOT NEW.buyer_gstin OR OLD.buyer_name IS NOT NEW.buyer_name OR OLD.buyer_address IS NOT NEW.buyer_address
        BEGIN SELECT RAISE(ABORT, 'A bill''s buyer cannot change'); END;
    `);
  },
};
