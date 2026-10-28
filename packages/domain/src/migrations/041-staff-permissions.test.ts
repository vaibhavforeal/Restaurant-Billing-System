import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("stores per-person permission changes and refuses admin-only ones", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('a', 'Asha', 'h', 'admin', 0), ('c', 'Meena', 'h', 'cashier', 0);
      INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES ('c', 'catalog.manage', 1, 0, 'a'), ('c', 'bills.refund', 0, 0, 'a');`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_permissions").get()).toEqual({ n: 2 });
    expect(() => db.exec("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES ('c', 'users.manage', 1, 0, 'a')")).toThrow();
    expect(() => db.exec("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES ('c', 'catalog.manage', 0, 0, 'a')")).toThrow();
    expect(() => db.exec("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES ('c', 'bad', 1, 0, 'a')")).toThrow();
  } finally { db.close(); }
});
