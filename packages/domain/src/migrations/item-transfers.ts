import type { Migration } from "../migrate.js";

export const itemTransfers: Migration = {
  version: 55, name: "item_transfers",
  up(db) {
    db.exec(`CREATE TABLE order_item_transfers (
      client_ref TEXT PRIMARY KEY, request_json TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id), target_order_id TEXT NOT NULL REFERENCES orders(id),
      created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
    );
    CREATE TRIGGER order_item_transfers_no_update BEFORE UPDATE ON order_item_transfers BEGIN SELECT RAISE(ABORT, 'Item transfer history is append-only'); END;
    CREATE TRIGGER order_item_transfers_no_delete BEFORE DELETE ON order_item_transfers BEGIN SELECT RAISE(ABORT, 'Item transfer history is append-only'); END;`);
  },
};
