import type { Migration } from "../migrate.js";
import { saveReportLines } from "../report-lines.js";

export const migration017: Migration = {
  version: 17,
  name: "report-snapshots-and-cancellation-audit",
  up(db) {
    db.exec(`
      ALTER TABLE order_items ADD COLUMN cancelled_at INTEGER;
      ALTER TABLE orders ADD COLUMN cancelled_by TEXT REFERENCES users(id);
      ALTER TABLE orders ADD COLUMN cancel_reason TEXT;
      CREATE INDEX idx_order_items_cancelled ON order_items(cancelled_at) WHERE cancelled_at IS NOT NULL;
      CREATE INDEX idx_kots_created ON kots(created_at);
      CREATE INDEX idx_stock_moves_created ON stock_moves(created_at);
      CREATE TABLE bill_report_lines (
        bill_id TEXT NOT NULL REFERENCES bills(id), order_item_id TEXT NOT NULL REFERENCES order_items(id),
        product_id TEXT NOT NULL, variant_id TEXT, name TEXT NOT NULL, category_id TEXT, category_name TEXT NOT NULL,
        qty INTEGER NOT NULL, subtotal_paise INTEGER NOT NULL, discount_paise INTEGER NOT NULL,
        taxable_paise INTEGER NOT NULL, cgst_paise INTEGER NOT NULL, sgst_paise INTEGER NOT NULL,
        rounding_paise INTEGER NOT NULL, total_paise INTEGER NOT NULL,
        PRIMARY KEY (bill_id, order_item_id)
      );
    `);
    const bills = db.prepare("SELECT id FROM bills ORDER BY id").all() as { id: string }[];
    for (const bill of bills) saveReportLines(db, bill.id, true);
    db.exec(`CREATE TRIGGER bill_report_lines_no_update BEFORE UPDATE ON bill_report_lines BEGIN SELECT RAISE(ABORT, 'bill report lines are immutable'); END;
      CREATE TRIGGER bill_report_lines_no_delete BEFORE DELETE ON bill_report_lines BEGIN SELECT RAISE(ABORT, 'bill report lines are immutable'); END;`);
  },
};
