import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database, uuidv7 } from "./index.js";
import { nextSplitLabel } from "./split-labels.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("nextSplitLabel", () => {
  it("returns 'A' for an empty table", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const tableId = uuidv7();
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);
    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("returns 'B' when 'A' is open", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'open', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("returns 'B' when 'A' is billed", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'billed', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("reuses 'A' when 'A' is settled", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'settled', ?, ?, ?)"
    ).run(orderA, tableId, userId, Date.now(), Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("reuses 'A' when 'A' is cancelled", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'cancelled', ?, ?, ?)"
    ).run(orderA, tableId, userId, Date.now(), Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("fills gaps (A and C active -> returns 'B')", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    const orderC = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'open', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-c', 'dine_in', ?, 'C', 'open', ?, ?)"
    ).run(orderC, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("returns null when all 26 letters are used", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    // Insert 26 open orders with labels A-Z
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 26; i++) {
      const orderId = uuidv7();
      db.prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, 'dine_in', ?, ?, 'open', ?, ?)"
      ).run(orderId, `ref-${letters[i]!}`, tableId, letters[i]!, userId, Date.now());
    }

    expect(nextSplitLabel(db, tableId)).toBeNull();
  });
});
