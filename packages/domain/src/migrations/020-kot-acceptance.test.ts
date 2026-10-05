import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("backfills completed KOTs while leaving pending and new tickets unaccepted", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 20));
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Chef', 'hash', 'kitchen', 0);
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'order', 'parcel', 'u', 0);`);
    const stationId = (db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
    const insertKot = db.prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by, done_at) VALUES (?, 'o', ?, ?, 1, 'u', ?)");
    insertKot.run("done", 1, stationId, 500);
    insertKot.run("pending", 2, stationId, null);

    migrate(db, MIGRATIONS);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT id, accepted_at, done_at FROM kots ORDER BY id").all()).toEqual([
      { id: "done", accepted_at: 500, done_at: 500 },
      { id: "pending", accepted_at: null, done_at: null },
    ]);

    insertKot.run("new", 3, stationId, null);
    db.prepare("UPDATE kots SET accepted_at = ? WHERE id = 'pending'").run(700);
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT accepted_at, done_at FROM kots WHERE id = 'pending'").get()).toEqual({ accepted_at: 700, done_at: null });
    expect(db.prepare("SELECT accepted_at, done_at FROM kots WHERE id = 'new'").get()).toEqual({ accepted_at: null, done_at: null });
  } finally {
    db.close();
  }
});
