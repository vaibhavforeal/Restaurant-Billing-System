import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { migrate, type Migration } from "./migrate.js";

const m1: Migration = {
  version: 1,
  name: "create-a",
  up: (db) => db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)"),
};
const m2: Migration = {
  version: 2,
  name: "create-b",
  up: (db) => db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)"),
};

describe("openDb", () => {
  it("enables WAL-compatible mode and foreign keys", () => {
    const db = openDb(":memory:");
    // :memory: reports "memory" for journal_mode; foreign_keys must be 1
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("migrate", () => {
  it("applies pending migrations and records the version", () => {
    const db = openDb(":memory:");
    migrate(db, [m1, m2]);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    // both tables exist
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("is idempotent — re-running applies nothing", () => {
    const db = openDb(":memory:");
    migrate(db, [m1, m2]);
    migrate(db, [m1, m2]); // would throw "table a already exists" if re-applied
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("rolls back a failing migration and leaves version untouched", () => {
    const db = openDb(":memory:");
    const bad: Migration = {
      version: 1,
      name: "bad",
      up: (d) => {
        d.exec("CREATE TABLE good_table (id INTEGER PRIMARY KEY)");
        d.exec("THIS IS NOT SQL");
      },
    };
    expect(() => migrate(db, [bad])).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(names).not.toContain("good_table");
  });

  it("rejects out-of-order migration lists", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db, [m2, m1])).toThrow(/order/i);
  });

  it("rejects migrations with version < 1", () => {
    const db = openDb(":memory:");
    const zero: Migration = { version: 0, name: "zero", up: () => {} };
    expect(() => migrate(db, [zero])).toThrow(/version 0 < 1/);
  });
});
