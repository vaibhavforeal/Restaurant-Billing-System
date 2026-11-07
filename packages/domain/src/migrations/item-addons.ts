import type { Migration } from "../migrate.js";

/**
 * Item add-ons: groups of add-on products (min/max picks) attached to dishes, an "add-on only" flag on products, and
 * the link from an add-on order line to its dish. Add-on lines are normal priced lines, so they never use
 * `parent_item_id`, which marks a combo's ₹0 items.
 */
export const itemAddons: Migration = {
  version: 62,
  name: "item_addons",
  up(db) {
    db.exec(`
      ALTER TABLE products ADD COLUMN addon_only INTEGER NOT NULL DEFAULT 0 CHECK (addon_only IN (0, 1));

      CREATE TABLE addon_groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        min_picks   INTEGER NOT NULL CHECK (min_picks >= 0),
        max_picks   INTEGER NOT NULL CHECK (max_picks >= 1 AND max_picks >= min_picks),
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE addon_group_options (
        id          TEXT PRIMARY KEY,
        group_id    TEXT NOT NULL REFERENCES addon_groups(id),
        product_id  TEXT NOT NULL REFERENCES products(id),
        variant_id  TEXT REFERENCES variants(id),
        sort_order  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_addon_option_unique ON addon_group_options(group_id, product_id, COALESCE(variant_id, ''));

      CREATE TABLE product_addon_groups (
        product_id  TEXT NOT NULL REFERENCES products(id),
        group_id    TEXT NOT NULL REFERENCES addon_groups(id),
        sort_order  INTEGER NOT NULL,
        PRIMARY KEY (product_id, group_id)
      );

      ALTER TABLE order_items ADD COLUMN addon_of_item_id TEXT REFERENCES order_items(id);
      CREATE INDEX idx_order_items_addon_of ON order_items(addon_of_item_id) WHERE addon_of_item_id IS NOT NULL;
    `);
  },
};
