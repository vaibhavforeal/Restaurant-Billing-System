import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 60: bill charge rounding", () => {
  it("adds rounding_paise defaulting to 0 and keeps charge rows immutable", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 59));
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(60);
    for (const table of ["bill_charges", "credit_note_charges"]) {
      const col = (db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; dflt_value: string }>).find((c) => c.name === "rounding_paise");
      expect(col, table).toMatchObject({ notnull: 1, dflt_value: "0" });
    }
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO bill_charges (bill_id, kind, label, gst_rate, amount_paise, taxable_paise, cgst_paise, sgst_paise) VALUES ('b', 'service', 'Service charge', 5, 100, 95, 2, 3)").run();
    expect(db.prepare("SELECT rounding_paise FROM bill_charges").get()).toEqual({ rounding_paise: 0 });
    expect(() => db.prepare("UPDATE bill_charges SET rounding_paise = 5").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM bill_charges").run()).toThrow(/immutable/);
    db.close();
  });
});
