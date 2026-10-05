import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function seeded() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS.filter((m) => m.version < 25));
  db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
    INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o1', 'ref-o1', 'parcel', 'u', 1);
    INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_by, created_at)
      VALUES ('b1', 1, 'o1', 10000, 250, 250, 0, 10500, 'paid', 'u', 2);`);
  return db;
}

describe("migration 025 credit notes", () => {
  it("adds append-only credit note tables and the credit_note_no sequence", () => {
    const db = seeded();
    try {
      const billBefore = db.prepare("SELECT * FROM bills WHERE id = 'b1'").get();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT * FROM bills WHERE id = 'b1'").get()).toEqual(billBefore);
      expect(db.prepare("SELECT value FROM sequences WHERE name = 'credit_note_no'").get()).toEqual({ value: 0 });

      const insertNote = (id: string, cnNo: number, kind: string, clientRef: string) =>
        db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise,
            requested_by, approved_by, created_at, client_ref, request_json)
          VALUES (?, ?, 'b1', ?, 'Wrong dish', 10000, 250, 250, 0, 10500, 'u', 'u', 3, ?, '{}')`).run(id, cnNo, kind, clientRef);
      insertNote("c1", 1, "refund", "cn-ref-0001");
      expect(() => insertNote("c2", 1, "void", "cn-ref-0002")).toThrow(/UNIQUE/);
      expect(() => insertNote("c3", 2, "void", "cn-ref-0001")).toThrow(/UNIQUE/);
      expect(() => insertNote("c4", 3, "swap", "cn-ref-0004")).toThrow();

      db.exec(`INSERT INTO categories (id, name) VALUES ('cat', 'Mains');
        INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p', 'cat', 'Dosa', 10000, 5, 0);
        INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty)
          VALUES ('i1', 'o1', 'p', 'Dosa', 10000, 5, 1);
        INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty)
          VALUES ('i2', 'o1', 'p', 'Dosa', 10000, 5, 1);`);
      db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_id, category_name, gst_rate, qty,
          taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise) VALUES ('c1', 'i1', 'Dosa', 'cat', 'Mains', 5, 1, 10000, 250, 250, 0, 10500)`).run();
      expect(() => db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_name, gst_rate, qty,
          taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise) VALUES ('c1', 'i1', 'Dosa', 'Mains', 5, 1, 0, 0, 0, 0, 0)`).run()).toThrow(/UNIQUE|PRIMARY/);
      expect(() => db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_name, gst_rate, qty,
          taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise) VALUES ('c1', 'i2', 'Dosa', 'Mains', 5, 0, 0, 0, 0, 0, 0)`).run()).toThrow();
      db.prepare("INSERT INTO credit_note_taxes (credit_note_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES ('c1', 5, 10000, 250, 250)").run();
      expect(() => db.prepare("INSERT INTO credit_note_taxes (credit_note_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES ('c1', 5, 1, 0, 0)").run()).toThrow(/UNIQUE|PRIMARY/);

      const insertRefund = (id: string, mode: string, amount: number) =>
        db.prepare("INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, created_at) VALUES (?, 'c1', ?, ?, 3)").run(id, mode, amount);
      insertRefund("r1", "cash", 10500);
      expect(() => insertRefund("r2", "cash", 0)).toThrow();
      expect(() => insertRefund("r3", "cheque", 100)).toThrow();

      const touch: Record<string, string> = {
        credit_notes: "reason = 'x'", credit_note_lines: "qty = 2", credit_note_taxes: "taxable_paise = 1", refund_payments: "amount_paise = 1",
      };
      for (const [table, assignment] of Object.entries(touch)) {
        expect(() => db.prepare(`UPDATE ${table} SET ${assignment}`).run()).toThrow(/append-only/);
        expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
      }
    } finally {
      db.close();
    }
  });

  it("indexes credit notes by bill and date and refunds by credit note", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["idx_credit_notes_bill", "idx_credit_notes_created", "idx_refund_payments_note"]));
    } finally {
      db.close();
    }
  });
});
