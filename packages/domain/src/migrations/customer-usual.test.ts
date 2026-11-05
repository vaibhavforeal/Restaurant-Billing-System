import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 51: customer's usual", () => {
  it("adds customer_usual_enabled to settings, on by default", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(51);
    expect(db.prepare("SELECT customer_usual_enabled AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    expect(() => db.prepare("UPDATE settings SET customer_usual_enabled = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
