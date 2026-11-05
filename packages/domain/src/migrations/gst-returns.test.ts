import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 53: GST returns", () => {
  it("adds the SAC code, Zomato GSTIN, customer GSTIN and an unchangeable bill buyer", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(53);
    expect(db.prepare("SELECT sac_code AS sac, zomato_gstin AS zomato FROM settings WHERE id = 1").get()).toEqual({ sac: "996331", zomato: "" });
    expect(() => db.prepare("UPDATE settings SET sac_code = '99A3' WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET sac_code = '996' WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET zomato_gstin = 'short' WHERE id = 1").run()).toThrow();

    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, created_at, created_by,
      buyer_gstin, buyer_name) VALUES ('b1', 1, 'o1', 0, 0, 0, 0, 0, 'u', '29AAPFU0939F1ZR', 'Acme Pvt Ltd')`).run();
    db.prepare("UPDATE bills SET status = 'paid', buyer_name = 'Acme Pvt Ltd' WHERE id = 'b1'").run();
    expect(() => db.prepare("UPDATE bills SET buyer_name = 'Other' WHERE id = 'b1'").run()).toThrow(/buyer cannot change/);
    expect(() => db.prepare("UPDATE bills SET buyer_gstin = NULL WHERE id = 'b1'").run()).toThrow(/buyer cannot change/);
    expect(() => db.prepare("UPDATE customers SET gstin = 'x' WHERE 1").run()).not.toThrow();
    db.close();
  });
});
