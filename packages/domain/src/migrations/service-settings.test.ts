import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

const columns = "order_warn_minutes, order_late_minutes, kot_print_with_kds, pay_cash_enabled, pay_card_enabled, pay_upi_enabled, qr_auto_accept, day_start_hour";

describe("migration 64: service settings", () => {
  it("adds the settings with their defaults", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(64);
    expect(db.prepare(`SELECT ${columns} FROM settings WHERE id = 1`).get()).toEqual({
      order_warn_minutes: 15, order_late_minutes: 25, kot_print_with_kds: 1,
      pay_cash_enabled: 1, pay_card_enabled: 1, pay_upi_enabled: 1, qr_auto_accept: 0, day_start_hour: 0,
    });
    db.close();
  });

  it("carries the Zomato amber and red minutes over to every order", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version < 64));
    db.prepare("UPDATE zomato_settings SET warn_minutes = 20, late_minutes = 35 WHERE id = 1").run();
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT order_warn_minutes, order_late_minutes FROM settings WHERE id = 1").get()).toEqual({ order_warn_minutes: 20, order_late_minutes: 35 });
    db.close();
  });

  it("rejects values outside their ranges", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const set = (sql: string) => () => db.prepare(`UPDATE settings SET ${sql} WHERE id = 1`).run();
    expect(set("order_warn_minutes = 0")).toThrow();
    expect(set("order_late_minutes = 241")).toThrow();
    expect(set("kot_print_with_kds = 2")).toThrow();
    expect(set("pay_upi_enabled = -1")).toThrow();
    expect(set("qr_auto_accept = 3")).toThrow();
    expect(set("day_start_hour = 7")).toThrow();
    expect(set("day_start_hour = -1")).toThrow();
    expect(set("day_start_hour = 6")).not.toThrow();
    db.close();
  });
});
