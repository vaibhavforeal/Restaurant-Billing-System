import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 48: popular by time of day", () => {
  it("adds popular_by_time_enabled to settings, on by default", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(48);
    expect(db.prepare("SELECT popular_by_time_enabled AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    expect(() => db.prepare("UPDATE settings SET popular_by_time_enabled = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
