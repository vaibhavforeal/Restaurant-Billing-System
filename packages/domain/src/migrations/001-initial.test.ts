import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

describe("migration 001", () => {
  it("creates every table the spec names, plus implementation tables", () => {
    const db = freshDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(names).toEqual(
      [
        "bill_taxes", "bills", "categories", "dining_tables", "kot_stations",
        "kots", "order_items", "orders", "payments", "printers", "product_stock_links",
        "products", "sequences", "sessions", "settings", "stock_items", "stock_moves",
        "users", "variants",
      ].sort(),
    );
  });

  it("seeds the settings singleton, a default Kitchen station, and the bill sequence", () => {
    const db = freshDb();
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
    expect(settings.setup_complete).toBe(0);
    const station = db.prepare("SELECT * FROM kot_stations").get() as any;
    expect(station.name).toBe("Kitchen");
    const seq = db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get() as any;
    expect(seq.value).toBe(0);
  });

  it("enforces foreign keys", () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        "INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p1', 'no-such-category', 'Tea', 1000, 5, 0)",
      ).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a second settings row", () => {
    const db = freshDb();
    expect(() => db.prepare("INSERT INTO settings (id) VALUES (2)").run()).toThrow();
  });
});
