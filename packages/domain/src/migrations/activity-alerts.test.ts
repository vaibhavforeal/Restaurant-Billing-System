import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 52: staff activity alert limits", () => {
  it("adds the alert limits to settings with their defaults", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(52);
    expect(db.prepare(`SELECT alert_cash_short_paise AS cashShort, alert_discount_percent AS discount, alert_pay_out_paise AS payOut,
      alert_multiplier AS multiplier, alert_min_events AS minEvents FROM settings WHERE id = 1`).get())
      .toEqual({ cashShort: 20000, discount: 20, payOut: 50000, multiplier: 2, minEvents: 3 });
    expect(() => db.prepare("UPDATE settings SET alert_multiplier = 0.5 WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE settings SET alert_min_events = 0 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
