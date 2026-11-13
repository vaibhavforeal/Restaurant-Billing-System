import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";
import { saveCafe } from "../cafe.js";
import { sqliteDriver } from "../testing/sqlite-driver.js";

const cafeInput = { name: "Chai Point", address: "", phone: "", gstin: "", fssai: "", gstMode: "none", defaultGstRate: 0,
  roundOff: "off", invoicePrefix: "", receiptHeader: "", receiptFooter: "", receiptStyle: "classic", upiId: "" };

function phase1Db() {
  const db = sqliteDriver(new Database(":memory:"));
  migrate(db, MIGRATIONS.filter((m) => m.version <= 3));
  return db;
}
const tables = (db: ReturnType<typeof phase1Db>) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);

describe("migration 4", () => {
  it("migrates an empty database to version 4 with the new tables and columns", () => {
    const db = sqliteDriver(new Database(":memory:"));
    expect(migrate(db, MIGRATIONS.filter((m) => m.version <= 4))).toBe(4);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(4);
    expect(tables(db)).toEqual(expect.arrayContaining(["staff", "customers", "held_carts"]));
    saveCafe(db, cafeInput, 1);
    expect(db.get<{ kitchen_slip: string }>("SELECT kitchen_slip FROM cafe")!.kitchen_slip).toBe("off");
    db.run(`INSERT INTO bills (id, device_id, bill_no, invoice_no, token, business_date, created_at, discount_paise, total_paise,
      totals_json, receipt_json, updated_at) VALUES ('b1', 'd', 1, 'A1', 1, '2026-11-13', 1, 0, 0, '{}', '{}', 1)`);
    expect(db.get<{ order_kind: string }>("SELECT order_kind FROM bills")!.order_kind).toBe("takeaway");
  });
  it("turns a Phase 1 owner PIN into an owner staff row", () => {
    const db = phase1Db();
    saveCafe(db, cafeInput, 1000);
    db.run("UPDATE cafe SET owner_pin_hash = 'abc'");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    const rows = db.all<{ name: string; role: string; pin_hash: string; active: number; sort: number; updated_at: number }>("SELECT * FROM staff");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Owner", role: "owner", pin_hash: "abc", active: 1, sort: 1, updated_at: 1000 });
  });
  it("adds no staff when there was no owner PIN", () => {
    const db = phase1Db();
    saveCafe(db, cafeInput, 1000);
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    expect(db.all("SELECT * FROM staff")).toEqual([]);
  });
});
