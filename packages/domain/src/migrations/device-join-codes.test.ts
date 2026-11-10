import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 66: device join codes", () => {
  const fresh = () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO devices (id, kind, name, credential_hash, created_at) VALUES ('d1', 'counter', 'Main', 'h1', 1)").run();
    return db;
  };
  const insert = (db: ReturnType<typeof fresh>, row: { id: string; hash: string; kind?: string; replaces?: string | null }) =>
    db.prepare("INSERT INTO device_join_codes (id, code_hash, kind, name, replaces_device_id, created_by, created_at, expires_at) VALUES (?, ?, ?, 'Pass', ?, 'Asha', 1, 2)")
      .run(row.id, row.hash, row.kind ?? "kitchen", row.replaces ?? null);

  it("holds a code for a new device and one that replaces a device", () => {
    const db = fresh();
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(66);
    insert(db, { id: "c1", hash: "x" });
    insert(db, { id: "c2", hash: "y", replaces: "d1" });
    expect(db.prepare("SELECT id, used_at FROM device_join_codes ORDER BY id").all()).toEqual([{ id: "c1", used_at: null }, { id: "c2", used_at: null }]);
    db.close();
  });

  it("refuses a repeated code hash, an unknown kind and a device that does not exist", () => {
    const db = fresh();
    insert(db, { id: "c1", hash: "x" });
    expect(() => insert(db, { id: "c2", hash: "x" })).toThrow(/UNIQUE/);
    expect(() => insert(db, { id: "c3", hash: "z", kind: "display" })).toThrow(/CHECK/);
    expect(() => insert(db, { id: "c4", hash: "w", replaces: "nobody" })).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
