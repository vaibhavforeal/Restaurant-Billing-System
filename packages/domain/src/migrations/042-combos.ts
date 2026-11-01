import type { Migration } from "../migrate.js";

/**
 * Combos. A combo is a product of kind 'combo', so it keeps the category, prices, GST rate, photo and availability of
 * any product. Its slots (`combo_groups`) list the items it can hold (`combo_options`): a slot whose minimum equals its
 * option count is fixed and always included. A combo on an order is one priced line; the items in it are ₹0 lines
 * whose `parent_item_id` names that line, so each goes to its own kitchen station and takes its own recipe stock.
 * `bill_report_lines.parent_order_item_id` keeps that link in the sales reports.
 */
export const migration042: Migration = {
  version: 42,
  name: "combos",
  up(db) {
    db.exec(`
      ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'combo'));
      CREATE TABLE combo_groups (
        id          TEXT PRIMARY KEY,
        combo_id    TEXT NOT NULL REFERENCES products(id),
        name        TEXT NOT NULL,
        min_picks   INTEGER NOT NULL CHECK (min_picks >= 0),
        max_picks   INTEGER NOT NULL CHECK (max_picks >= 1 AND max_picks >= min_picks),
        sort_order  INTEGER NOT NULL
      );
      CREATE INDEX idx_combo_groups_combo ON combo_groups(combo_id, sort_order);
      CREATE TABLE combo_options (
        id                 TEXT PRIMARY KEY,
        group_id           TEXT NOT NULL REFERENCES combo_groups(id),
        product_id         TEXT NOT NULL REFERENCES products(id),
        variant_id         TEXT REFERENCES variants(id),
        qty                INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
        extra_price_paise  INTEGER NOT NULL DEFAULT 0 CHECK (extra_price_paise >= 0),
        sort_order         INTEGER NOT NULL
      );
      CREATE INDEX idx_combo_options_group ON combo_options(group_id, sort_order);
      CREATE INDEX idx_combo_options_product ON combo_options(product_id);
      ALTER TABLE order_items ADD COLUMN parent_item_id TEXT REFERENCES order_items(id);
      CREATE INDEX idx_order_items_parent ON order_items(parent_item_id) WHERE parent_item_id IS NOT NULL;
      ALTER TABLE bill_report_lines ADD COLUMN parent_order_item_id TEXT;
    `);
  },
};
