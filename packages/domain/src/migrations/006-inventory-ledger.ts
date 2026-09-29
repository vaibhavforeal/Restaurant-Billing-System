import type { Migration } from "../migrate.js";

export const migration006: Migration = {
  version: 6,
  name: "inventory-ledger-references",
  up(db) {
    db.exec(`
      ALTER TABLE stock_items ADD COLUMN client_ref TEXT;
      ALTER TABLE stock_items ADD COLUMN request_json TEXT;
      ALTER TABLE stock_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_stock_items_ref ON stock_items(client_ref) WHERE client_ref IS NOT NULL;
      ALTER TABLE products ADD COLUMN stock_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE stock_moves ADD COLUMN client_ref TEXT;
      ALTER TABLE stock_moves ADD COLUMN request_json TEXT;
      ALTER TABLE stock_moves ADD COLUMN order_item_id TEXT REFERENCES order_items(id);
      ALTER TABLE stock_moves ADD COLUMN reversal_of TEXT REFERENCES stock_moves(id);
      ALTER TABLE stock_moves ADD COLUMN balance_after REAL;
      CREATE UNIQUE INDEX idx_stock_moves_ref ON stock_moves(client_ref) WHERE client_ref IS NOT NULL;
      CREATE UNIQUE INDEX idx_stock_sale_item ON stock_moves(order_item_id, stock_item_id) WHERE reason = 'sale' AND order_item_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_stock_reversal ON stock_moves(reversal_of) WHERE reversal_of IS NOT NULL;
      CREATE INDEX idx_stock_moves_order_item ON stock_moves(order_item_id);
      CREATE INDEX idx_stock_moves_history ON stock_moves(stock_item_id, id);
      CREATE TRIGGER stock_moves_no_update BEFORE UPDATE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock history is append-only'); END;
      CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves BEGIN SELECT RAISE(ABORT, 'stock history is append-only'); END;
    `);
  },
};
