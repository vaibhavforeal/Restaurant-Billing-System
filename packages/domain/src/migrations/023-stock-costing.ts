import type { Migration } from "../migrate.js";

export const migration023: Migration = {
  version: 23,
  name: "stock-costing",
  up(db) {
    // Costs are nullable: an item without a cost simply has unknown value, never a guessed zero.
    // Unit cost is stored in milli-paise (1/1000 paise) so per-gram / per-ml prices keep precision.
    db.exec(`
      ALTER TABLE stock_items ADD COLUMN unit_cost_milli_paise INTEGER;
      ALTER TABLE stock_moves ADD COLUMN cost_paise INTEGER;
      ALTER TABLE stock_moves ADD COLUMN unit_cost_after INTEGER;
      CREATE TABLE stock_cost_changes (
        id                   TEXT PRIMARY KEY,
        stock_item_id        TEXT NOT NULL REFERENCES stock_items(id),
        old_cost_milli_paise INTEGER,
        new_cost_milli_paise INTEGER NOT NULL CHECK (new_cost_milli_paise > 0),
        note                 TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        created_by           TEXT NOT NULL REFERENCES users(id),
        client_ref           TEXT UNIQUE,
        request_json         TEXT
      );
      CREATE INDEX idx_stock_cost_changes_item ON stock_cost_changes(stock_item_id, created_at);
      CREATE TRIGGER stock_cost_changes_no_update BEFORE UPDATE ON stock_cost_changes BEGIN SELECT RAISE(ABORT, 'stock cost history is append-only'); END;
      CREATE TRIGGER stock_cost_changes_no_delete BEFORE DELETE ON stock_cost_changes BEGIN SELECT RAISE(ABORT, 'stock cost history is append-only'); END;
    `);
  },
};
