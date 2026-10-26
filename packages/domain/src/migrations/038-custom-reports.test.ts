import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("adds saved reports with unique case-insensitive names and valid JSON", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 38));
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u1', 'Asha', 'x', 'admin', 1)").run();
    const insert = db.prepare("INSERT INTO saved_reports (id, name, config_json, created_at, updated_at, created_by) VALUES (?, ?, ?, 1, 1, 'u1')");
    insert.run("r1", "Daily sales", "{}");
    expect(() => insert.run("r2", "daily SALES", "{}")).toThrow();
    expect(() => insert.run("r3", "Broken", "{not json")).toThrow();
    expect(() => insert.run("r4", "   ", "{}")).toThrow();
  } finally { db.close(); }
});
