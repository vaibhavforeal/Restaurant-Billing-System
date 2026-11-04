import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 47: ordered together", () => {
  it("adds ordered_together_enabled to settings, on by default", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(47);
    expect(db.prepare("SELECT ordered_together_enabled AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    expect(() => db.prepare("UPDATE settings SET ordered_together_enabled = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
