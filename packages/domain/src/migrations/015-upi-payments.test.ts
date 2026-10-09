import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("UPI settings upgrade", () => {
  it("preserves restaurant data and is safe to run again", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 15));
      db.prepare("UPDATE settings SET restaurant_name = 'Existing cafe', tax_inclusive = 1 WHERE id = 1").run();
      const before = db.prepare("SELECT * FROM settings").get() as object;
      migrate(db, MIGRATIONS.filter((m) => m.version <= 30)); // later migrations drop tax_inclusive and gst_scheme
      expect(db.prepare("SELECT * FROM settings").get()).toEqual({ ...before, upi_id: "", require_kitchen_acceptance: 1, receipt_style: "classic", gst_scheme: "regular" });
      db.prepare("UPDATE settings SET upi_id = 'cafe@bank'").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT upi_id FROM settings").get()).toEqual({ upi_id: "cafe@bank" });
    } finally { db.close(); }
  });
});
