import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

const before = MIGRATIONS.filter((m) => m.version < 40);
const crm = (db: ReturnType<typeof openDb>) => db.prepare("SELECT enabled FROM integration_state WHERE id = 'crm'").get();

it("turns CRM & Loyalty on for an installation that already has customers", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, before);
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'hash', 'admin', 0);
      INSERT INTO customers (id, name, phone, created_at, created_by) VALUES ('c', 'Priya', '9876543210', 0, 'u');`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(crm(db)).toEqual({ enabled: 1 });
  } finally { db.close(); }
});

it("leaves CRM & Loyalty off for a new installation", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, before);
    db.exec("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'hash', 'admin', 0)");
    migrate(db, MIGRATIONS);
    expect(crm(db)).toBeUndefined();
  } finally { db.close(); }
});
