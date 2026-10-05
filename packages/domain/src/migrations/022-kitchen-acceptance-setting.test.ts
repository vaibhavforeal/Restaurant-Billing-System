import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 022 kitchen acceptance setting", () => {
  it("keeps the billing gate on for existing restaurants", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 22));
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT require_kitchen_acceptance AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    } finally {
      db.close();
    }
  });
});
