import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 026 integration state", () => {
  it("creates an empty integration_state table with checked values and a user foreign key", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 26));
      db.exec("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0)");
      migrate(db, MIGRATIONS);
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT COUNT(*) FROM integration_state").get()).toEqual({ "COUNT(*)": 0 });

      const insert = (id: string, enabled: number, by: string) =>
        db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES (?, ?, 1, ?)").run(id, enabled, by);
      expect(() => insert("zomato", 2, "u")).toThrow();
      expect(() => insert("zomato", 1, "ghost")).toThrow();
      insert("zomato", 1, "u");
      expect(db.prepare("SELECT id, enabled FROM integration_state").all()).toEqual([{ id: "zomato", enabled: 1 }]);
      expect(() => insert("zomato", 0, "u")).toThrow(/UNIQUE|PRIMARY/);
    } finally {
      db.close();
    }
  });
});
