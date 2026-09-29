import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("billing migration", () => {
  it("upgrades the existing schema without changing profile or bill sequence", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.slice(0, 4));
      db.prepare("UPDATE settings SET restaurant_name = 'Existing cafe'").run();
      db.prepare("UPDATE sequences SET value = 17 WHERE name = 'bill_no'").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT restaurant_name, tax_inclusive FROM settings").get()).toEqual({ restaurant_name: "Existing cafe", tax_inclusive: 0 });
      expect(db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get()).toEqual({ value: 17 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => db.prepare("UPDATE settings SET tax_inclusive = 2").run()).toThrow();
    } finally { db.close(); }
  });
});
