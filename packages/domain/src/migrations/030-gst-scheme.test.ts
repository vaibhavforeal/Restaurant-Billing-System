import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("GST scheme upgrade", () => {
  it("keeps existing settings, defaults to regular GST, and preserves a later choice on rerun", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 30));
      db.prepare("UPDATE settings SET restaurant_name = 'Existing cafe', tax_inclusive = 1").run();
      const before = db.prepare("SELECT * FROM settings").get() as object;
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT * FROM settings").get()).toEqual({ ...before, gst_scheme: "regular" });
      db.prepare("UPDATE settings SET gst_scheme = 'composition'").run();
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT gst_scheme FROM settings").get()).toEqual({ gst_scheme: "composition" });
      expect(() => db.prepare("UPDATE settings SET gst_scheme = 'unregistered'").run()).toThrow();
    } finally { db.close(); }
  });
});
