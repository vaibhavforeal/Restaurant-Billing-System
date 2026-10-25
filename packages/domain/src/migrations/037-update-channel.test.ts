import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("starts every installation on the stable update channel", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 37));
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT update_channel FROM settings").get()).toEqual({ update_channel: "stable" });
    db.exec("UPDATE settings SET update_channel = 'patch'");
    expect(() => db.exec("UPDATE settings SET update_channel = 'nightly'")).toThrow();
  } finally { db.close(); }
});
