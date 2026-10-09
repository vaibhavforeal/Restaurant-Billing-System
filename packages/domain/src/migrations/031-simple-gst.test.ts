import { describe, expect, it } from "vitest";
import { openDb, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

const columns = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe("simple GST upgrade", () => {
  it("maps settings, keeps rate overrides, and is safe to rerun", () => {
    const db = openDb(":memory:");
    const regular = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version <= 30));
      db.prepare("UPDATE settings SET gst_scheme = 'composition'").run();
      db.exec(`
        INSERT INTO categories (id, name) VALUES ('c', 'Mains');
        INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p5', 'c', 'Dosa', 10000, 5, 0);
        INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p18', 'c', 'Wine', 10000, 18, 0);
        INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p0', 'c', 'Milk', 10000, 0, 0);
      `);
      migrate(db, MIGRATIONS);
      const settings = db.prepare("SELECT * FROM settings").get() as Record<string, unknown>;
      expect(settings).toMatchObject({ gst_mode: "none", gst_rate: 5 });
      expect(settings).not.toHaveProperty("tax_inclusive");
      expect(settings).not.toHaveProperty("gst_scheme");
      const rates = () => db.prepare("SELECT id, gst_rate FROM products ORDER BY id").all();
      const expected = [{ id: "p0", gst_rate: 0 }, { id: "p18", gst_rate: 18 }, { id: "p5", gst_rate: null }];
      expect(rates()).toEqual(expected);

      migrate(regular, MIGRATIONS);
      expect(regular.prepare("SELECT gst_mode, gst_rate FROM settings").get()).toEqual({ gst_mode: "included", gst_rate: 5 });

      expect(() => db.prepare("UPDATE settings SET gst_rate = 28").run()).toThrow();
      expect(() => db.prepare("UPDATE settings SET gst_mode = 'exclusive'").run()).toThrow();
      expect(() => db.prepare("UPDATE products SET gst_rate = 7").run()).toThrow();
      db.prepare("UPDATE products SET gst_rate = NULL").run();
      expect(columns(db, "guest_requests")).not.toContain("tax_inclusive");

      db.prepare("UPDATE products SET gst_rate = 12 WHERE id = 'p5'").run();
      db.prepare("UPDATE settings SET gst_rate = 18").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT gst_mode, gst_rate FROM settings").get()).toEqual({ gst_mode: "none", gst_rate: 18 });
      expect(rates()).toEqual([{ id: "p0", gst_rate: null }, { id: "p18", gst_rate: null }, { id: "p5", gst_rate: 12 }]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); regular.close(); }
  });
});
