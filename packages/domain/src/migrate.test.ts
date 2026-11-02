import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { migrate, type Migration } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";

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

  it("starts from a baseline: builds a new database, skips one already there, and refuses one from before it", () => {
    const baseline: Migration = { version: 5, name: "baseline", baseline: true, up: (d) => d.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)") };
    const m6: Migration = { version: 6, name: "add-b", up: (d) => d.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)") };
    const fresh = openDb(":memory:");
    migrate(fresh, [baseline, m6]);
    expect(fresh.pragma("user_version", { simple: true })).toBe(6);

    const atBaseline = openDb(":memory:");
    atBaseline.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    atBaseline.pragma("user_version = 5");
    migrate(atBaseline, [baseline, m6]); // would throw "table a already exists" if the baseline ran again
    expect(atBaseline.pragma("user_version", { simple: true })).toBe(6);

    const older = openDb(":memory:");
    older.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    older.pragma("user_version = 3");
    expect(() => migrate(older, [baseline, m6])).toThrow(/older than this app can upgrade/);
    expect(older.pragma("user_version", { simple: true })).toBe(3);
  });

  it("creates dashboard_layouts at version 44", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(44);
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u1', 'A', 'x', 'admin', 1)").run();
    expect(() => db.prepare("INSERT INTO dashboard_layouts (user_id, layout_json, updated_at) VALUES ('u1', 'not json', 1)").run()).toThrow();
  });
});
