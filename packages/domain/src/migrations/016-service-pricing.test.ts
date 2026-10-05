import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("upgrades existing prices and order snapshots without repricing and can rerun", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter(m => m.version < 16));
    db.exec(`INSERT INTO categories (id, name) VALUES ('c', 'Meals');
      INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p', 'c', 'Meal', 10000, 5, 0);
      INSERT INTO variants (id, product_id, name, price_paise) VALUES ('v', 'p', 'Half', 6000);
      INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Staff', 'hash', 'admin', 0);
      INSERT INTO dining_tables (id, name, area) VALUES ('t', 'T1', 'AC');
      INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES ('o', 'existing-ref', 'dine_in', 't', 'u', 0);
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('parcel', 'parcel-ref', 'parcel', 'u', 0);
      INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty) VALUES ('i', 'o', 'p', 'Meal', 9000, 5, 1);`);
    const before = db.prepare("SELECT * FROM order_items").all();
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT * FROM order_items").all()).toEqual(before.map((row: any) => ({ ...row, cancelled_at: null })));
    expect(db.prepare("SELECT price_paise, ac_price_paise, takeaway_price_paise FROM products").get()).toEqual({ price_paise: 10000, ac_price_paise: null, takeaway_price_paise: null });
    expect(db.prepare("SELECT price_paise, ac_price_paise FROM variants").get()).toEqual({ price_paise: 6000, ac_price_paise: null });
    expect(db.prepare("SELECT price_tier FROM dining_tables").get()).toEqual({ price_tier: "non_ac" });
    expect(db.prepare("SELECT price_tier FROM orders WHERE id='parcel'").get()).toEqual({ price_tier: "takeaway" });
    expect(() => db.exec("UPDATE products SET ac_price_paise = -1")).toThrow();
  } finally { db.close(); }
});
