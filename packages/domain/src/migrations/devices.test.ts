import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function before65() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS.filter((m) => m.version < 65));
  return db;
}
type Db = ReturnType<typeof before65>;
const licensed = (db: Db, id: string, createdAt: number, extra: { revokedAt?: number; lastSeenAt?: number; version?: number } = {}) =>
  db.prepare("INSERT INTO licensed_devices (id, credential_hash, name, created_at, revoked_at, last_seen_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, `hash-${id}`, `Device ${id}`, createdAt, extra.revokedAt ?? null, extra.lastSeenAt ?? null, extra.version ?? 1);

describe("migration 65: devices", () => {
  it("creates empty devices and device_events tables and drops licensed_devices", () => {
    const db = before65();
    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(65);
    expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM device_events").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('licensed_devices','idx_licensed_devices_active')").all()).toEqual([]);
    db.close();
  });

  it("carries licensed devices across as counters and marks the oldest active one as main", () => {
    const db = before65();
    licensed(db, "A", 100, { revokedAt: 500 });
    licensed(db, "B", 200, { lastSeenAt: 900, version: 3 });
    licensed(db, "C", 300);
    migrate(db, MIGRATIONS);
    const rows = db.prepare("SELECT id, kind, is_main, removed_at, settings FROM devices ORDER BY created_at").all();
    expect(rows).toEqual([
      { id: "A", kind: "counter", is_main: 0, removed_at: 500, settings: "{}" },
      { id: "B", kind: "counter", is_main: 1, removed_at: null, settings: "{}" },
      { id: "C", kind: "counter", is_main: 0, removed_at: null, settings: "{}" },
    ]);
    expect(db.prepare("SELECT last_seen_at, version FROM devices WHERE id = 'B'").get()).toEqual({ last_seen_at: 900, version: 3 });
    expect(db.prepare("SELECT name, credential_hash, created_at FROM devices WHERE id = 'C'").get())
      .toEqual({ name: "Device C", credential_hash: "hash-C", created_at: 300 });
    db.close();
  });

  it("marks no main when every licensed device was revoked", () => {
    const db = before65();
    licensed(db, "A", 100, { revokedAt: 500 });
    licensed(db, "B", 200, { revokedAt: 600 });
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM devices WHERE is_main = 1").get()).toEqual({ n: 0 });
    db.close();
  });

  it("moves device events out of license_events", () => {
    const db = before65();
    const event = db.prepare("INSERT INTO license_events (occurred_at, actor_name, kind, summary, revision, device_id) VALUES (?, ?, ?, ?, ?, ?)");
    event.run(10, "Asha", "license_activated", "Pro license applied.", 1, null);
    event.run(20, "Asha", "device_registered", "Registered Counter.", null, "B");
    event.run(30, "Ravi", "device_renamed", "Renamed Counter to Till.", null, "B");
    event.run(40, "Asha", "device_removed", "Removed Old.", null, "A");
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT kind FROM license_events").all()).toEqual([{ kind: "license_activated" }]);
    expect(db.prepare("SELECT device_id, kind FROM device_events ORDER BY id").all()).toEqual([
      { device_id: "B", kind: "joined" }, { device_id: "B", kind: "renamed" }, { device_id: "A", kind: "removed" },
    ]);
    expect(db.prepare("SELECT occurred_at, actor_name, summary FROM device_events ORDER BY id").all()).toEqual([
      { occurred_at: 20, actor_name: "Asha", summary: "Registered Counter." },
      { occurred_at: 30, actor_name: "Ravi", summary: "Renamed Counter to Till." },
      { occurred_at: 40, actor_name: "Asha", summary: "Removed Old." },
    ]);
    db.close();
  });

  it("allows one main counter and only the three kinds", () => {
    const db = before65();
    migrate(db, MIGRATIONS);
    const add = (id: string, kind: string, isMain: number) => () =>
      db.prepare("INSERT INTO devices (id, kind, name, credential_hash, is_main, created_at) VALUES (?, ?, ?, ?, ?, 1)").run(id, kind, id, `hash-${id}`, isMain);
    expect(add("one", "counter", 1)).not.toThrow();
    expect(add("two", "kitchen", 1)).toThrow();
    expect(add("three", "captain", 0)).not.toThrow();
    expect(add("four", "tablet", 0)).toThrow();
    db.close();
  });
});
