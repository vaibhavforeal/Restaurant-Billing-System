import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("adds append-only KOT edit history, partial stock returns and the print setting", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 33));
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT kot_edit_print FROM settings").get()).toEqual({ kot_edit_print: "ask" });
    expect(() => db.exec("UPDATE settings SET kot_edit_print = 'sometimes'")).toThrow();
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Staff', 'hash', 'admin', 0);
      INSERT INTO categories (id, name) VALUES ('c', 'Meals');
      INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES ('p', 'c', 'Meal', 10000, 0);
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'ref-o', 'parcel', 'u', 0);
      INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status) VALUES ('i', 'o', 'p', 'Meal', 10000, 5, 3, 'sent');`);
    const edit = (ref: string, newQty: number) => db.prepare(`INSERT INTO kot_edits (id, order_item_id, order_id, old_qty, new_qty, printed, created_at, created_by, client_ref, request_json)
      VALUES (?, 'i', 'o', 3, ?, 1, 0, 'u', ?, '{}')`).run(ref, newQty, ref);
    edit("e1", 2);
    expect(() => edit("e2", 4)).toThrow();
    expect(() => db.exec("UPDATE kot_edits SET reason = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM kot_edits")).toThrow(/append-only/);
  } finally { db.close(); }
});
