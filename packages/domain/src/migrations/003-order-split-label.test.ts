import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database } from "../index.js";
import { uuidv7 } from "../id.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("migration 003", () => {
  it("adds split_label column and backfills dine_in orders with 'A', leaves parcels NULL", () => {
    db = openDb(":memory:");
    // Migrate to version 2 first
    migrate(db, MIGRATIONS.slice(0, 2));

    // Insert FK targets (users + dining_tables required by orders)
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    // Insert one dine_in and one parcel order
    const dineInId = uuidv7();
    const parcelId = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, 'ref-dine', 'dine_in', ?, ?, ?)"
    ).run(dineInId, tableId, userId, Date.now());
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, 'ref-parcel', 'parcel', NULL, ?, ?)"
    ).run(parcelId, userId, Date.now());

    // Apply migration 003
    migrate(db, MIGRATIONS);

    // Verify backfill
    const dineIn = db.prepare("SELECT split_label FROM orders WHERE id = ?").get(dineInId) as { split_label: string | null };
    expect(dineIn.split_label).toBe("A");

    const parcel = db.prepare("SELECT split_label FROM orders WHERE id = ?").get(parcelId) as { split_label: string | null };
    expect(parcel.split_label).toBeNull();
  });
});
