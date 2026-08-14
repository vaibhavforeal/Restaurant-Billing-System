import type { Migration } from "../migrate.js";

/** M3a: KOT done-state for the kitchen display; per-item client refs for idempotent punching. */
export const migration002: Migration = {
  version: 2,
  name: "kot-done-and-item-refs",
  up(db) {
    db.exec(`
      ALTER TABLE kots ADD COLUMN done_at INTEGER;
      ALTER TABLE order_items ADD COLUMN client_ref TEXT;
      CREATE UNIQUE INDEX idx_order_items_client_ref
        ON order_items(client_ref) WHERE client_ref IS NOT NULL;
    `);
  },
};
