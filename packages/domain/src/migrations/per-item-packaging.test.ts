import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function seedCategory(db: ReturnType<typeof openDb>): void {
  db.prepare("INSERT INTO categories (id, name) VALUES ('c', 'Mains')").run();
}

describe("migration 61: per-item packaging", () => {
  it("adds the packaging columns with their defaults", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(61);
    seedCategory(db);
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES ('p', 'c', 'Biryani', 20000, 0)").run();
    db.prepare("INSERT INTO variants (id, product_id, name, price_paise) VALUES ('v', 'p', 'Full', 30000)").run();
    expect(db.prepare("SELECT packaging_paise FROM products WHERE id = 'p'").get()).toEqual({ packaging_paise: 0 });
    expect(db.prepare("SELECT packaging_paise FROM variants WHERE id = 'v'").get()).toEqual({ packaging_paise: null });
    expect(db.prepare("SELECT packaging_per_item FROM settings WHERE id = 1").get()).toEqual({ packaging_per_item: 0 });
    expect(() => db.prepare("UPDATE settings SET packaging_per_item = 2 WHERE id = 1").run()).toThrow();
    for (const [table, name] of [["bill_report_lines", "packaging_paise"], ["credit_note_charges", "amount_paise"]]) {
      const col = (db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; dflt_value: string }>).find((c) => c.name === name);
      expect(col, table).toMatchObject({ notnull: 1, dflt_value: "0" });
    }
    db.close();
  });

  it("rejects packaging outside 0-100000", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    seedCategory(db);
    const product = db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at, packaging_paise) VALUES (?, 'c', 'X', 100, 0, ?)");
    expect(() => product.run("ok", 100000)).not.toThrow();
    expect(() => product.run("high", 100001)).toThrow();
    expect(() => product.run("low", -1)).toThrow();
    const variant = db.prepare("INSERT INTO variants (id, product_id, name, price_paise, packaging_paise) VALUES (?, 'ok', 'V', 100, ?)");
    expect(() => variant.run("v0", 0)).not.toThrow();
    expect(() => variant.run("vhigh", 100001)).toThrow();
    expect(() => variant.run("vlow", -1)).toThrow();
    db.close();
  });

  it("backfills credited charge amounts and keeps charge credits immutable", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 60));
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO bill_charges (bill_id, kind, label, gst_rate, amount_paise, taxable_paise, cgst_paise, sgst_paise) VALUES ('b1', 'packaging', 'Packaging', 5, 2000, 1905, 48, 47)").run();
    db.prepare("INSERT INTO bill_charges (bill_id, kind, label, gst_rate, amount_paise, taxable_paise, cgst_paise, sgst_paise) VALUES ('b1', 'service', 'Service charge', 5, 700, 667, 17, 16)").run();
    db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, requested_by, approved_by, created_at, client_ref, request_json)
      VALUES ('cn1', 1, 'b1', 'void', 'x', 0, 0, 0, 0, 0, 'u', 'u', 0, 'r1', '{}')`).run();
    db.prepare("INSERT INTO credit_note_charges (credit_note_id, kind, label, gst_rate, taxable_paise, cgst_paise, sgst_paise, total_paise) VALUES ('cn1', 'packaging', 'Packaging', 5, 1905, 48, 47, 2000)").run();
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT amount_paise FROM credit_note_charges WHERE credit_note_id = 'cn1' AND kind = 'packaging'").get()).toEqual({ amount_paise: 2000 });
    expect(() => db.prepare("UPDATE credit_note_charges SET amount_paise = 1").run()).toThrow(/credit note charges are immutable/);
    db.close();
  });
});
