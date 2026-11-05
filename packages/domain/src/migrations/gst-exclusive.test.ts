import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 58: GST added on top", () => {
  it("widens the gst_mode check and keeps every saved setting and earlier check", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 57));
    db.prepare("UPDATE settings SET restaurant_name = 'Spice', round_off = 'half', invoice_prefix = 'MP' WHERE id = 1").run();
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(58);
    expect(db.prepare("SELECT restaurant_name, round_off, invoice_prefix FROM settings WHERE id = 1").get()).toEqual({ restaurant_name: "Spice", round_off: "half", invoice_prefix: "MP" });
    expect(() => db.prepare("UPDATE settings SET gst_mode = 'exclusive' WHERE id = 1").run()).not.toThrow();
    expect(() => db.prepare("UPDATE settings SET gst_mode = 'bogus' WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET round_off = 'paise' WHERE id = 1").run()).toThrow();
    db.close();
  });
});
