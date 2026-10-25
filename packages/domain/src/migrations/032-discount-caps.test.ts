import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("seeds today's limits and validates per-user overrides", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 32));
    db.exec("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Staff', 'hash', 'cashier', 0)");
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT role, max_percent FROM discount_caps ORDER BY role").all()).toEqual([
      { role: "admin", max_percent: null }, { role: "cashier", max_percent: 10 },
      { role: "kitchen", max_percent: 0 }, { role: "waiter", max_percent: 0 },
    ]);
    expect(db.prepare("SELECT max_discount_percent FROM users WHERE id = 'u'").get()).toEqual({ max_discount_percent: null });
    expect(() => db.exec("UPDATE users SET max_discount_percent = 101")).toThrow();
    expect(() => db.exec("UPDATE discount_caps SET max_percent = -1 WHERE role = 'cashier'")).toThrow();
  } finally { db.close(); }
});
