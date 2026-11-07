import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 59: bill charges", () => {
  it("adds charge settings with defaults and checks", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 58));
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(59);
    expect(db.prepare("SELECT service_charge_bp, packaging_charge_paise, service_charge_label, packaging_charge_label FROM settings WHERE id = 1").get())
      .toEqual({ service_charge_bp: 0, packaging_charge_paise: 0, service_charge_label: "Service charge", packaging_charge_label: "Packaging" });
    expect(() => db.prepare("UPDATE settings SET service_charge_bp = 2000, packaging_charge_paise = 100000 WHERE id = 1").run()).not.toThrow();
    expect(() => db.prepare("UPDATE settings SET service_charge_bp = 2001 WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET packaging_charge_paise = -1 WHERE id = 1").run()).toThrow();
    db.close();
  });

  it("keeps earlier settings and checks when migrating up", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 58));
    db.prepare("UPDATE settings SET restaurant_name = 'Spice', gst_mode = 'exclusive' WHERE id = 1").run();
    const columns = () => db.prepare("PRAGMA table_info(settings)").all();
    const before = columns();
    migrate(db, MIGRATIONS);
    // Every earlier column keeps its name, type, NOT NULL and default; the new ones only come after them.
    expect(columns().slice(0, before.length)).toEqual(before);
    expect(db.prepare("SELECT restaurant_name, gst_mode FROM settings WHERE id = 1").get()).toEqual({ restaurant_name: "Spice", gst_mode: "exclusive" });
    for (const mode of ["included", "exclusive", "none"]) expect(() => db.prepare("UPDATE settings SET gst_mode = ? WHERE id = 1").run(mode), mode).not.toThrow();
    expect(() => db.prepare("UPDATE settings SET gst_mode = 'bogus' WHERE id = 1").run()).toThrow(/CHECK constraint/);
    db.close();
  });

  it("adds bills.charges_paise and immutable charge tables", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect((db.prepare("PRAGMA table_info(bills)").all() as { name: string; dflt_value: string }[]).find((c) => c.name === "charges_paise")?.dflt_value).toBe("0");
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO bill_charges (bill_id, kind, label, percent_bp, gst_rate, amount_paise, taxable_paise, cgst_paise, sgst_paise) VALUES ('b1', 'service', 'Service charge', 1000, 5, 100, 100, 3, 3)").run();
    expect(() => db.prepare("UPDATE bill_charges SET amount_paise = 1").run()).toThrow(/bill charges are immutable/);
    expect(() => db.prepare("DELETE FROM bill_charges").run()).toThrow(/bill charges are immutable/);
    expect(() => db.prepare("INSERT INTO bill_charges (bill_id, kind, label, gst_rate, amount_paise, taxable_paise, cgst_paise, sgst_paise) VALUES ('b1', 'tip', 'x', 5, 1, 1, 0, 0)").run()).toThrow();
    db.prepare("INSERT INTO credit_note_charges (credit_note_id, kind, label, gst_rate, taxable_paise, cgst_paise, sgst_paise, total_paise) VALUES ('c1', 'packaging', 'Packaging', 5, 100, 3, 3, 106)").run();
    expect(() => db.prepare("UPDATE credit_note_charges SET total_paise = 1").run()).toThrow(/credit note charges are immutable/);
    expect(() => db.prepare("DELETE FROM credit_note_charges").run()).toThrow(/credit note charges are immutable/);
    db.close();
  });
});
