import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function fresh() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO categories (id, name) VALUES ('c', 'Mains')").run();
  db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES ('cheese', 'c', 'Cheese', 3000, 0)").run();
  return db;
}

describe("migration 62: item add-ons", () => {
  it("adds addon_only defaulting to 0", () => {
    const db = fresh();
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(62);
    expect(db.prepare("SELECT addon_only FROM products WHERE id = 'cheese'").get()).toEqual({ addon_only: 0 });
    expect(() => db.prepare("UPDATE products SET addon_only = 2 WHERE id = 'cheese'").run()).toThrow(/CHECK/);
    db.close();
  });

  it("enforces group pick bounds", () => {
    const db = fresh();
    const group = db.prepare("INSERT INTO addon_groups (id, name, min_picks, max_picks, created_at) VALUES (?, 'G', ?, ?, 0)");
    expect(() => group.run("ok", 0, 2)).not.toThrow();
    expect(() => group.run("inverted", 2, 1)).toThrow(/CHECK/);
    expect(() => group.run("zero", 0, 0)).toThrow(/CHECK/);
    expect(db.prepare("SELECT is_active FROM addon_groups WHERE id = 'ok'").get()).toEqual({ is_active: 1 });
    db.close();
  });

  it("rejects the same option twice in a group", () => {
    const db = fresh();
    db.prepare("INSERT INTO addon_groups (id, name, min_picks, max_picks, created_at) VALUES ('g', 'Toppings', 0, 2, 0)").run();
    const option = db.prepare("INSERT INTO addon_group_options (id, group_id, product_id, variant_id, sort_order) VALUES (?, 'g', 'cheese', NULL, ?)");
    option.run("o1", 0);
    expect(() => option.run("o2", 1)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO product_addon_groups (product_id, group_id, sort_order) VALUES ('cheese', 'g', 0)").run();
    expect(() => db.prepare("INSERT INTO product_addon_groups (product_id, group_id, sort_order) VALUES ('cheese', 'g', 1)").run()).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });

  it("links an add-on line to its item", () => {
    const db = fresh();
    const col = (db.pragma("table_info(order_items)") as Array<{ name: string; notnull: number }>).find((c) => c.name === "addon_of_item_id");
    expect(col).toMatchObject({ notnull: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_order_items_addon_of'").get()).toBeTruthy();
    db.close();
  });
});
