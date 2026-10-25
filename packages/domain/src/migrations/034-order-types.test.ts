import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("seeds the built-in order types and leaves existing orders on them", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 34));
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Staff', 'hash', 'admin', 0);
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'ref-o', 'parcel', 'u', 0);`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT id, kind, is_system FROM order_types ORDER BY sort_order").all()).toEqual([
      { id: "dine_in", kind: "dine_in", is_system: 1 }, { id: "parcel", kind: "takeaway", is_system: 1 }, { id: "zomato", kind: "aggregator", is_system: 1 },
    ]);
    expect(db.prepare("SELECT order_type_id, order_type_name FROM orders").get()).toEqual({ order_type_id: null, order_type_name: null });
    expect(() => db.exec("INSERT INTO order_types (id, name, kind, created_at) VALUES ('x', 'takeaway', 'delivery', 0)")).toThrow();
    expect(() => db.exec("INSERT INTO order_types (id, name, kind, created_at) VALUES ('y', 'Drone', 'teleport', 0)")).toThrow();
  } finally { db.close(); }
});
