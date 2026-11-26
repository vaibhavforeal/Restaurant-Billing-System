import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("preserves separate balances when upgrading outstanding cashier shifts", () => {
  const db = openDb(":memory:");
  try {
    migrate(db,MIGRATIONS.filter(m => m.version < 64));
    for (const [id,float] of [["first",100],["second",200]] as const) {
      db.prepare("INSERT INTO users(id,name,username,password_hash,pin_hash,role,created_at) VALUES(?,?,?,'hash','hash','cashier',1)").run(id,id,id);
      db.prepare("INSERT INTO shifts(id,cashier_id,opened_at,opening_float_paise,open_client_ref) VALUES(?,?,1,?,?)").run(id,id,float,id);
    }
    migrate(db,MIGRATIONS);
    expect(db.prepare("SELECT drawer_id,opening_float_paise FROM shifts ORDER BY id").all()).toEqual([
      {drawer_id:"first",opening_float_paise:100},{drawer_id:"second",opening_float_paise:200},
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
