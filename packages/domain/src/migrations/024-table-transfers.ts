import type { Migration } from "../migrate.js";

export const migration024: Migration = {
  version: 24,
  name: "table-transfers",
  up(db) {
    // A merged order stays as a closed record pointing at the order that absorbed it.
    // table_links lets one order occupy several tables (merge); it is active only while the order is open or billed.
    // order_table_events is the append-only audit log of every move and merge, keyed by client_ref for idempotent retries.
    db.exec(`
      ALTER TABLE orders ADD COLUMN merged_into TEXT REFERENCES orders(id);
      CREATE TABLE table_links (
        id        TEXT PRIMARY KEY,
        table_id  TEXT NOT NULL REFERENCES dining_tables(id),
        order_id  TEXT NOT NULL REFERENCES orders(id),
        linked_at INTEGER NOT NULL,
        linked_by TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_table_links_table ON table_links(table_id);
      CREATE INDEX idx_table_links_order ON table_links(order_id);
      CREATE TABLE order_table_events (
        id                  TEXT PRIMARY KEY,
        kind                TEXT NOT NULL CHECK (kind IN ('move','merge')),
        order_id            TEXT NOT NULL,
        target_order_id     TEXT,
        from_table_id       TEXT,
        to_table_id         TEXT,
        folded_captain_name TEXT,
        created_at          INTEGER NOT NULL,
        created_by          TEXT NOT NULL REFERENCES users(id),
        client_ref          TEXT NOT NULL UNIQUE,
        request_json        TEXT NOT NULL
      );
      CREATE TRIGGER order_table_events_no_update BEFORE UPDATE ON order_table_events BEGIN SELECT RAISE(ABORT, 'table transfer history is append-only'); END;
      CREATE TRIGGER order_table_events_no_delete BEFORE DELETE ON order_table_events BEGIN SELECT RAISE(ABORT, 'table transfer history is append-only'); END;
    `);
  },
};
