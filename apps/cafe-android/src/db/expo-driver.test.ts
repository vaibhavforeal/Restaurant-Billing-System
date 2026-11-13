import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, getCafe, migrate, saveCafe } from "@masalapos/cafe-data";
import { expoDriver, type SyncSqlite } from "./expo-driver";

const base = { name: " Chai Point ", address: "", phone: "", gstin: "", fssai: "", gstMode: "included", defaultGstRate: 5, roundOff: "rupee",
  invoicePrefix: "cp", receiptHeader: "", receiptFooter: "", receiptStyle: "classic", upiId: "" };

/** An in-memory better-sqlite3 database in the shape of expo-sqlite's synchronous calls, including its null for "no row". */
function fakeSyncSqlite(): SyncSqlite {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return {
    runSync: (sql, params) => db.prepare(sql).run(...params),
    getFirstSync: <T>(sql: string, params: unknown[]) => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllSync: <T>(sql: string, params: unknown[]) => db.prepare(sql).all(...params) as T[],
    withTransactionSync(task) {
      db.exec("BEGIN");
      try { task(); db.exec("COMMIT"); } catch (e) { if (db.inTransaction) db.exec("ROLLBACK"); throw e; }
    },
  };
}

describe("expoDriver", () => {
  // This proves the adapter, not expo.
  it("passes cafe-data's own flow through the adapter", () => {
    const db = expoDriver(fakeSyncSqlite());
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    saveCafe(db, base, 1);
    expect(getCafe(db)!.name).toBe("Chai Point");
    expect(db.get("SELECT 1 AS one WHERE 1 = 0")).toBeUndefined(); // null from expo becomes undefined
    expect(db.transaction(() => 42)).toBe(42);                      // the callback's value comes back
  });

  it("refuses a transaction inside a transaction and rolls the outer one back", () => {
    const db = expoDriver(fakeSyncSqlite());
    migrate(db);
    expect(() => db.transaction(() => { db.run("INSERT INTO sequences (name, value) VALUES ('a', 1)"); db.transaction(() => 1); })).toThrow(/nested/);
    expect(db.get("SELECT name FROM sequences")).toBeUndefined();
  });
});
