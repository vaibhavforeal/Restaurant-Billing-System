import { describe, expect, it } from "vitest";
import { migrate, type Migration } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

describe("migrate", () => {
  it("creates every table from an empty database and records the version", () => {
    const db = memoryCafeDb();
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(names).toEqual(["bill_lines", "bill_voids", "bills", "cafe", "categories", "device", "error_log", "item_variants", "items", "local_state", "payments", "printers", "sequences"]);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(3);
  });
  it("applies only newer migrations and keeps existing rows", () => {
    const db = memoryCafeDb();
    db.run("INSERT INTO sequences (name, value) VALUES ('x', 7)");
    const next: Migration = { version: 4, up: (d) => d.run("ALTER TABLE sequences ADD COLUMN note TEXT") };
    expect(migrate(db, [...MIGRATIONS, next])).toBe(4);
    expect(db.get<{ value: number }>("SELECT value FROM sequences WHERE name = 'x'")!.value).toBe(7);
  });
  it("rolls back a failing migration and leaves the version alone", () => {
    const db = memoryCafeDb();
    const bad: Migration = { version: 4, up: (d) => { d.run("CREATE TABLE t (a)"); d.run("NOT SQL"); } };
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 't'")).toBeUndefined();
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(3);
  });
  it("refuses a database made by a newer app", () => {
    const db = memoryCafeDb();
    db.run("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer version/);
  });
  it("refuses a transaction inside a transaction", () => {
    const db = memoryCafeDb();
    expect(() => db.transaction(() => db.transaction(() => 1))).toThrow(/nested/);
  });
});
