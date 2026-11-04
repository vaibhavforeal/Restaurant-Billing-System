import { describe, expect, it } from "vitest";
import { migrate } from "../migrate.js";
import { openDb } from "../db.js";
import { MIGRATIONS } from "./index.js";
import { usernameFromName } from "./password-login.js";

describe("migration 50: password sign-in", () => {
  it("gives existing people a unique username from their name and their PIN hash as the password", () => {
    const db = openDb(":memory:");
    migrate(db, MIGRATIONS.filter((m) => m.version < 50));
    const insert = db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("a", "Asha K.", "hash-a", "admin", 1);
    insert.run("b", "asha k", "hash-b", "cashier", 2);
    insert.run("c", "रवि", "hash-c", "waiter", 3);
    migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT id, username, password_hash FROM users ORDER BY id").all()).toEqual([
      { id: "a", username: "ashak", password_hash: "hash-a" },
      { id: "b", username: "ashak2", password_hash: "hash-b" },
      { id: "c", username: "user", password_hash: "hash-c" },
    ]);
    expect(() => insert.run("d", "x", "h", "cashier", 4)).not.toThrow();
    expect(() => db.prepare("UPDATE users SET username = 'ASHAK' WHERE id = 'd'").run()).toThrow(/UNIQUE/);
  });

  it("makes names of at least three characters", () => {
    expect(usernameFromName("Al", new Set())).toBe("aluser");
    expect(usernameFromName("_.Ravi", new Set())).toBe("ravi");
  });
});
