import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 45: hold orders", () => {
  it("adds held to order_items and hold_orders_enabled to settings", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(45);
    const held = (db.pragma("table_info(order_items)") as Array<{ name: string; dflt_value: string | null; notnull: number }>).find((c) => c.name === "held");
    expect(held).toMatchObject({ dflt_value: "0", notnull: 1 });
    expect(db.prepare("SELECT hold_orders_enabled AS v FROM settings WHERE id = 1").get()).toEqual({ v: 1 });
    expect(() => db.prepare("UPDATE settings SET hold_orders_enabled = 2 WHERE id = 1").run()).toThrow();
    db.close();
  });
});
