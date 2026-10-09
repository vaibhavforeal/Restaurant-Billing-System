import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

describe("migration 028 zomato age thresholds", () => {
  it("gives the existing settings row amber after 15 and red after 25 minutes", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version <= 27));
    db.prepare("UPDATE zomato_settings SET restaurant_id='R1', version=4 WHERE id=1").run();
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT restaurant_id, version, warn_minutes, late_minutes FROM zomato_settings WHERE id=1").get())
      .toEqual({ restaurant_id: "R1", version: 4, warn_minutes: 15, late_minutes: 25 });
    db.close();
  });

  it("refuses minutes outside 1 to 240", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    for (const column of ["warn_minutes", "late_minutes"]) {
      for (const value of [0, -1, 241]) {
        expect(() => db.prepare(`UPDATE zomato_settings SET ${column}=? WHERE id=1`).run(value)).toThrow(/CHECK/);
      }
      expect(() => db.prepare(`UPDATE zomato_settings SET ${column}=NULL WHERE id=1`).run()).toThrow();
      db.prepare(`UPDATE zomato_settings SET ${column}=? WHERE id=1`).run(1);
      db.prepare(`UPDATE zomato_settings SET ${column}=? WHERE id=1`).run(240);
    }
    db.close();
  });
});
