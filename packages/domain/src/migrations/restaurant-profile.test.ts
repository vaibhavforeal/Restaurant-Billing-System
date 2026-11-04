import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.js";
import { openDb } from "../db.js";
import { MIGRATIONS } from "./index.js";

describe("migration 47: restaurant profile", () => {
  it("adds empty phone, city, state and PIN code to the settings row", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(47);
    expect(db.prepare("SELECT phone, city, state_code, pincode FROM settings WHERE id = 1").get()).toEqual({ phone: "", city: "", state_code: "", pincode: "" });
  });
});
