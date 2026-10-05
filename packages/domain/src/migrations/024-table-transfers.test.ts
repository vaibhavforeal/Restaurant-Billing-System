import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 024 table transfers", () => {
  it("adds merge tracking, table links and an append-only transfer log", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 24));
      db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
        INSERT INTO dining_tables (id, name) VALUES ('t3', 'T3');
        INSERT INTO dining_tables (id, name) VALUES ('t4', 'T4');
        INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES ('o1', 'ref-o1', 'dine_in', 't3', 'u', 1);`);
      migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT merged_into FROM orders WHERE id = 'o1'").get()).toEqual({ merged_into: null });

      db.prepare("INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES ('l1', 't4', 'o1', 2, 'u')").run();
      expect(db.prepare("SELECT table_id, order_id FROM table_links WHERE id = 'l1'").get()).toEqual({ table_id: "t4", order_id: "o1" });

      const insertEvent = (id: string, kind: string, clientRef: string) =>
        db.prepare(`INSERT INTO order_table_events (id, kind, order_id, from_table_id, to_table_id, created_at, created_by, client_ref, request_json)
          VALUES (?, ?, 'o1', 't3', 't4', 3, 'u', ?, '{}')`).run(id, kind, clientRef);
      insertEvent("e1", "move", "move-ref-1");
      expect(() => insertEvent("e2", "swap", "move-ref-2")).toThrow();
      expect(() => insertEvent("e3", "merge", "move-ref-1")).toThrow(/UNIQUE/);
      expect(() => db.prepare("UPDATE order_table_events SET kind = 'merge'").run()).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM order_table_events").run()).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });
});
