import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 023 stock costing", () => {
  it("adds nullable cost columns and an append-only cost-change log", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 23));
      db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
        INSERT INTO stock_items (id, name, unit, qty) VALUES ('s', 'Paneer', 'kg', 2);
        INSERT INTO stock_moves (id, stock_item_id, delta, reason, created_at, created_by) VALUES ('m', 's', 2, 'purchase', 1, 'u');`);
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT unit_cost_milli_paise FROM stock_items").get()).toEqual({ unit_cost_milli_paise: null });
      expect(db.prepare("SELECT cost_paise, unit_cost_after FROM stock_moves").get()).toEqual({ cost_paise: null, unit_cost_after: null });
      db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at, created_by)
        VALUES ('c', 's', NULL, 32000000, 'Opening cost', 2, 'u')`).run();
      expect(() => db.prepare("UPDATE stock_cost_changes SET note = 'x'").run()).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM stock_cost_changes").run()).toThrow(/append-only/);
      expect(() => db.prepare("UPDATE stock_moves SET cost_paise = 1").run()).toThrow(/append-only/);
      expect(() => db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, new_cost_milli_paise, note, created_at, created_by)
        VALUES ('z', 's', 0, 'bad', 3, 'u')`).run()).toThrow();
      // Every cost change records why and who (spec §3).
      expect(() => db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, new_cost_milli_paise, created_at, created_by)
        VALUES ('no-note', 's', 100, 4, 'u')`).run()).toThrow(/NOT NULL.*note/);
      expect(() => db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, new_cost_milli_paise, note, created_at)
        VALUES ('no-user', 's', 100, 'x', 5)`).run()).toThrow(/NOT NULL.*created_by/);
    } finally {
      db.close();
    }
  });
});
