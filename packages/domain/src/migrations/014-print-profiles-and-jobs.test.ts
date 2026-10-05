import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("print profile upgrade", () => {
  it("preserves existing printers and routing, adds compatible defaults, and is repeatable", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter(m => m.version < 14));
      db.prepare("INSERT INTO printers(id,name,kind,connection,paper_width,is_active) VALUES('existing','Kitchen','windows','Kitchen USB',58,0)").run();
      db.prepare("UPDATE kot_stations SET printer_id = 'existing'").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      const printer = db.prepare("SELECT * FROM printers WHERE id = 'existing'").get() as Record<string, unknown>;
      expect(printer).toMatchObject({ name: "Kitchen", kind: "windows", connection: "Kitchen USB", paper_width: 58, is_active: 0 });
      expect(JSON.parse(printer.receipt_profile as string)).toEqual({ copies: 1, feedLines: 3, autoCut: true });
      expect(printer.receipt_profile).toBe(printer.kot_profile);
      expect(db.prepare("SELECT printer_id FROM kot_stations").get()).toEqual({ printer_id: "existing" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM print_jobs").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
