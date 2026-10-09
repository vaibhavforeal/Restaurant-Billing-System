import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("receipt style upgrade", () => {
  it("keeps existing settings, defaults to classic, and preserves a later choice on rerun", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 29));
      db.prepare("UPDATE settings SET restaurant_name = 'Existing cafe', tax_inclusive = 1, upi_id = 'cafe@bank'").run();
      const before = db.prepare("SELECT * FROM settings").get() as object;
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT * FROM settings").get()).toEqual({ ...before, receipt_style: "classic", gst_scheme: "regular" });
      db.prepare("UPDATE settings SET receipt_style = 'heritage'").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT receipt_style FROM settings").get()).toEqual({ receipt_style: "heritage" });
      expect(() => db.prepare("UPDATE settings SET receipt_style = 'unknown'").run()).toThrow();
    } finally { db.close(); }
  });
});
