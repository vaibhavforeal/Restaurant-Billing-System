import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 46: popular items", () => {
  it("adds popular_items_enabled to settings, on by default", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(46);
    expect(db.prepare("SELECT popular_items_enabled AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    expect(() => db.prepare("UPDATE settings SET popular_items_enabled = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
