import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("inventory migration", () => {
  it("preserves existing stock and history, protects history, and runs once", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.slice(0, 5));
      db.prepare("INSERT INTO stock_items (id,name,unit,qty,low_stock_threshold) VALUES ('rice','Rice','kg',2.125,1)").run();
      db.prepare("INSERT INTO stock_moves (id,stock_item_id,delta,reason,created_at) VALUES ('opening','rice',2.125,'adjustment',1)").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT qty, version FROM stock_items WHERE id = 'rice'").get()).toEqual({ qty: 2.125, version: 0 });
      expect(db.prepare("SELECT delta, order_item_id, balance_after FROM stock_moves").get()).toEqual({ delta: 2.125, order_item_id: null, balance_after: null });
      expect(() => db.prepare("UPDATE stock_moves SET delta = 3").run()).toThrow("append-only");
      expect(() => db.prepare("DELETE FROM stock_moves").run()).toThrow("append-only");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
});
