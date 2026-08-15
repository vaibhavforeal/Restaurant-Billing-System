import { describe, it, expect } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";
import { uuidv7 } from "../id.js";

describe("migration 004: printer kinds", () => {
  it("rebuilds printers table with bluetooth kind and preserves existing data", () => {
    const db = openDb(":memory:");

    // Migrate to version 3
    migrate(db, MIGRATIONS.slice(0, 3));

    // Insert a network printer before migration
    const printerId = uuidv7();
    db.prepare("INSERT INTO printers (id, name, kind, connection, paper_width, is_active) VALUES (?, ?, ?, ?, ?, ?)")
      .run(printerId, "Test Printer", "network", "192.168.1.100", 80, 1);

    // Verify bluetooth kind fails before migration
    expect(() => {
      db.prepare("INSERT INTO printers (id, name, kind, connection, paper_width, is_active) VALUES (?, ?, ?, ?, ?, ?)")
        .run(uuidv7(), "BT Printer", "bluetooth", "COM3", 58, 1);
    }).toThrow();

    // Apply migration 004
    migrate(db, MIGRATIONS);

    // Verify existing printer survived
    const existing = db.prepare("SELECT * FROM printers WHERE id = ?").get(printerId) as {
      id: string; name: string; kind: string; connection: string; paper_width: number; is_active: number;
    };
    expect(existing).toEqual({
      id: printerId,
      name: "Test Printer",
      kind: "network",
      connection: "192.168.1.100",
      paper_width: 80,
      is_active: 1,
    });

    // Verify bluetooth kind now works
    const btId = uuidv7();
    db.prepare("INSERT INTO printers (id, name, kind, connection, paper_width, is_active) VALUES (?, ?, ?, ?, ?, ?)")
      .run(btId, "BT Printer", "bluetooth", "COM3", 58, 1);

    const bt = db.prepare("SELECT * FROM printers WHERE id = ?").get(btId) as { kind: string };
    expect(bt.kind).toBe("bluetooth");
  });

  it("preserves foreign key references to printers during rebuild", () => {
    const db = openDb(":memory:");

    // Migrate to version 3
    migrate(db, MIGRATIONS.slice(0, 3));

    // Insert a network printer
    const printerId = uuidv7();
    db.prepare("INSERT INTO printers (id, name, kind, connection, paper_width, is_active) VALUES (?, ?, ?, ?, ?, ?)")
      .run(printerId, "Kitchen Printer", "network", "192.168.1.100", 80, 1);

    // Insert a kot_station referencing the printer
    const stationId = uuidv7();
    db.prepare("INSERT INTO kot_stations (id, name, printer_id, is_active) VALUES (?, ?, ?, ?)")
      .run(stationId, "Main Station", printerId, 1);

    // Apply migration 004 (should handle FK constraint via defer_foreign_keys)
    migrate(db, MIGRATIONS);

    // Verify printer survived
    const printer = db.prepare("SELECT * FROM printers WHERE id = ?").get(printerId) as {
      id: string; name: string; kind: string; connection: string; paper_width: number; is_active: number;
    };
    expect(printer).toEqual({
      id: printerId,
      name: "Kitchen Printer",
      kind: "network",
      connection: "192.168.1.100",
      paper_width: 80,
      is_active: 1,
    });

    // Verify station survived and still references the printer
    const station = db.prepare("SELECT * FROM kot_stations WHERE id = ?").get(stationId) as {
      id: string; name: string; printer_id: string | null; is_active: number;
    };
    expect(station).toEqual({
      id: stationId,
      name: "Main Station",
      printer_id: printerId,
      is_active: 1,
    });

    // Verify no foreign key violations after migration
    const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
    expect(fkViolations).toHaveLength(0);
  });
});
