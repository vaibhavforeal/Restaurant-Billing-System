import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 56: bill settings", () => {
  it("adds the receipt header and the bill show toggles with defaults", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(56);
    expect(db.prepare(`SELECT receipt_header, bill_show_fssai, bill_show_customer, bill_show_table, bill_show_served_by, bill_show_item_gst
      FROM settings WHERE id = 1`).get()).toEqual({
      receipt_header: "", bill_show_fssai: 1, bill_show_customer: 1, bill_show_table: 1, bill_show_served_by: 0, bill_show_item_gst: 0,
    });
    expect(() => db.prepare("UPDATE settings SET bill_show_fssai = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
