import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 54: order summary", () => {
  it("upgrades existing orders with their original sales staff and empty details, and is repeatable", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 54));
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('old', 'ref', 'parcel', 'staff', 1)").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT order_notes, guest_count, sold_by_id, summary_revision FROM orders WHERE id = 'old'").get()).toEqual({ order_notes: "", guest_count: null, sold_by_id: "staff", summary_revision: 0 });
      db.prepare("UPDATE orders SET order_notes = 'Keep this note', guest_count = 3 WHERE id = 'old'").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT order_notes, guest_count FROM orders WHERE id = 'old'").get()).toEqual({ order_notes: "Keep this note", guest_count: 3 });
      expect(() => db.prepare("UPDATE orders SET guest_count = 0 WHERE id = 'old'").run()).toThrow();
    } finally { db.close(); }
  });
});
