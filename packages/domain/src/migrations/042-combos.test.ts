import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("makes existing products plain items and links combo lines to their items", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 42));
    db.exec(`INSERT INTO categories (id, name) VALUES ('c', 'Meals');
      INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p', 'c', 'Fries', 8000, 5, 0);`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT kind FROM products").get()).toEqual({ kind: "item" });
    db.exec(`INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at, kind) VALUES ('combo', 'c', 'Lunch', 19900, 5, 0, 'combo');
      INSERT INTO combo_groups (id, combo_id, name, min_picks, max_picks, sort_order) VALUES ('g', 'combo', 'Sides', 1, 1, 0);
      INSERT INTO combo_options (id, group_id, product_id, sort_order) VALUES ('o', 'g', 'p', 0);`);
    expect(db.prepare("SELECT qty, extra_price_paise FROM combo_options").get()).toEqual({ qty: 1, extra_price_paise: 0 });
    expect(() => db.exec("UPDATE products SET kind = 'meal'")).toThrow();
    expect(() => db.exec("INSERT INTO combo_groups (id, combo_id, name, min_picks, max_picks, sort_order) VALUES ('bad', 'combo', 'x', 2, 1, 1)")).toThrow();
    expect(() => db.exec("INSERT INTO combo_options (id, group_id, product_id, sort_order) VALUES ('o2', 'missing', 'p', 0)")).toThrow();
  } finally { db.close(); }
});
