import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database } from "./index.js";
import { nextSequence } from "./sequences.js";
import { localDateKey } from "./dates.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("migration 002", () => {
  it("adds done_at to kots and client_ref to order_items with unique index", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // test-only: dummy ids, FK targets don't exist
    db.pragma("foreign_keys = OFF");

    // Verify done_at column exists and is writable
    const kotId = "test-kot-id";
    db.prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kotId, "dummy-order", 1, "dummy-station", Date.now(), "dummy-user");

    const beforeDone = db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId) as { done_at: number | null };
    expect(beforeDone.done_at).toBeNull();

    const now = Date.now();
    db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(now, kotId);
    const afterDone = db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId) as { done_at: number };
    expect(afterDone.done_at).toBe(now);

    // Verify client_ref column and unique index
    const itemId1 = "item-1";
    const itemId2 = "item-2";
    db.prepare(
      "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(itemId1, "dummy-order", "dummy-product", "Test Item", 100, 5, 1, "ref-abc123");

    // Same client_ref should violate unique index
    expect(() => {
      db!.prepare(
        "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(itemId2, "dummy-order", "dummy-product", "Test Item 2", 200, 5, 1, "ref-abc123");
    }).toThrow();

    // NULL client_ref should be allowed (multiple NULLs don't violate partial unique index)
    db.prepare(
      "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(itemId2, "dummy-order", "dummy-product", "Test Item 2", 200, 5, 1, null);

    const item2 = db.prepare("SELECT client_ref FROM order_items WHERE id = ?").get(itemId2) as { client_ref: string | null };
    expect(item2.client_ref).toBeNull();
  });
});

describe("nextSequence", () => {
  it("starts at 1, increments, and isolates by name", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);

    expect(nextSequence(db, "test-seq")).toBe(1);
    expect(nextSequence(db, "test-seq")).toBe(2);
    expect(nextSequence(db, "test-seq")).toBe(3);

    // Different name starts at 1
    expect(nextSequence(db, "other-seq")).toBe(1);
    expect(nextSequence(db, "test-seq")).toBe(4);
  });

  it("works via UPDATE...RETURNING in a single statement", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);

    // Pre-seed a sequence
    db.prepare("INSERT INTO sequences (name, value) VALUES (?, ?)").run("existing", 10);
    expect(nextSequence(db, "existing")).toBe(11);
  });
});

describe("localDateKey", () => {
  it("pads month and day to YYYY-MM-DD", () => {
    // 2026-01-05 (months are 0-indexed in JS Date, so month 0 = January)
    const jan5 = new Date(2026, 0, 5).getTime();
    expect(localDateKey(jan5)).toBe("2026-01-05");

    // 2026-12-31
    const dec31 = new Date(2026, 11, 31).getTime();
    expect(localDateKey(dec31)).toBe("2026-12-31");
  });
});
