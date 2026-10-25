import type { Migration } from "../migrate.js";

/**
 * Editing an item after it reached the kitchen. `kot_edits` is the append-only history of every edit.
 * A quantity cut splits the removed part into its own cancelled item, so cancellation reports and bills stay
 * correct, and returns its stock with a `cancel_reversal` move whose `partial_of` names the sale move it reduces.
 * `settings.kot_edit_print`: 'ask' lets staff choose whether to print the edit slip, 'always' / 'never' decide for them.
 */
export const migration033: Migration = {
  version: 33,
  name: "kot-edits",
  up(db) {
    db.exec(`
      ALTER TABLE stock_moves ADD COLUMN partial_of TEXT REFERENCES stock_moves(id);
      CREATE INDEX idx_stock_moves_partial ON stock_moves(partial_of) WHERE partial_of IS NOT NULL;
      ALTER TABLE settings ADD COLUMN kot_edit_print TEXT NOT NULL DEFAULT 'ask' CHECK (kot_edit_print IN ('ask', 'always', 'never'));
      CREATE TABLE kot_edits (
        id                TEXT PRIMARY KEY,
        order_item_id     TEXT NOT NULL REFERENCES order_items(id),
        order_id          TEXT NOT NULL REFERENCES orders(id),
        kot_id            TEXT REFERENCES kots(id),
        old_qty           INTEGER NOT NULL,
        new_qty           INTEGER NOT NULL CHECK (new_qty > 0 AND new_qty <= old_qty),
        old_note          TEXT,
        new_note          TEXT,
        reason            TEXT,
        cancelled_item_id TEXT REFERENCES order_items(id),
        printed           INTEGER NOT NULL CHECK (printed IN (0, 1)),
        created_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL REFERENCES users(id),
        client_ref        TEXT NOT NULL UNIQUE,
        request_json      TEXT NOT NULL
      );
      CREATE INDEX idx_kot_edits_order ON kot_edits(order_id);
      CREATE TRIGGER kot_edits_no_update BEFORE UPDATE ON kot_edits BEGIN SELECT RAISE(ABORT, 'KOT edit history is append-only'); END;
      CREATE TRIGGER kot_edits_no_delete BEFORE DELETE ON kot_edits BEGIN SELECT RAISE(ABORT, 'KOT edit history is append-only'); END;
    `);
  },
};
