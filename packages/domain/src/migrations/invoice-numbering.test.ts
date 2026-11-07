import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 57: invoice numbering", () => {
  it("adds the invoice prefix and round-off settings with defaults and a round-off check", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(57);
    expect(db.prepare("SELECT invoice_prefix, round_off FROM settings WHERE id = 1").get()).toEqual({ invoice_prefix: "", round_off: "rupee" });
    expect(() => db.prepare("UPDATE settings SET round_off = 'paise' WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET invoice_prefix = 'ABCDE' WHERE id = 1").run()).toThrow();
    db.close();
  });

  it("keeps bills.invoice_no and credit_notes.credit_note_ref unique, allowing several NULLs", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    db.pragma("foreign_keys = OFF");
    const bill = db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, created_at, created_by, invoice_no)
      VALUES (?, ?, ?, 100, 0, 0, 100, 1, 'u', ?)`);
    bill.run("b1", 1, "o1", null);
    bill.run("b2", 2, "o2", null);
    bill.run("b3", 3, "o3", "25-26/0001");
    expect(() => bill.run("b4", 4, "o4", "25-26/0001")).toThrow(/UNIQUE/);

    const note = db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, requested_by, approved_by, created_at, client_ref, request_json, credit_note_ref)
      VALUES (?, ?, 'b3', 'void', 'x', 0, 0, 0, 0, 0, 'u', 'u', 1, ?, '{}', ?)`);
    note.run("c1", 1, "r1", null);
    note.run("c2", 2, "r2", null);
    note.run("c3", 3, "r3", "CN/25-26/001");
    expect(() => note.run("c4", 4, "r4", "CN/25-26/001")).toThrow(/UNIQUE/);
    db.close();
  });
});
