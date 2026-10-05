import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";
it("removes fixed defaults without rewriting saved orders", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 19));
    db.exec(`INSERT INTO users (id,name,pin_hash,role,created_at) VALUES ('u','Ravi','hash','waiter',0);
      INSERT INTO dining_tables (id,name,captain_id) VALUES ('t','T1','u');
      INSERT INTO orders (id,client_ref,type,table_id,opened_by,opened_at) VALUES ('old','old-order','dine_in','t','u',0);`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    db.exec("INSERT INTO orders (id,client_ref,type,table_id,opened_by,opened_at) VALUES ('new','new-order','dine_in','t','u',1)");
    expect(db.prepare("SELECT captain_name FROM orders WHERE id='old'").get()).toEqual({ captain_name: "Ravi" });
    expect(db.prepare("SELECT captain_id FROM orders WHERE id='new'").get()).toEqual({ captain_id: null });
    expect(db.prepare("PRAGMA table_info(dining_tables)").all().some((r: any) => r.name === "captain_id")).toBe(false);
  } finally { db.close(); }
});
