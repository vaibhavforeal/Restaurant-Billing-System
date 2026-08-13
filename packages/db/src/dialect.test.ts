import { getTableColumns } from "drizzle-orm";
import { expect, test } from "vitest";
import { defineTable } from "./dialect.js";

test("a table defined once exposes identical columns in both dialects", () => {
  const demo = defineTable("demo_rows", {
    id: { kind: "uuid", primaryKey: true },
    label: { kind: "text", notNull: true },
    amount_minor: { kind: "money", notNull: true },
    is_active: { kind: "boolean", notNull: true, default: true },
    created_at: { kind: "timestamp", notNull: true },
    payload: { kind: "json" },
  });

  const pgColumns = Object.keys(getTableColumns(demo.pg));
  const sqliteColumns = Object.keys(getTableColumns(demo.sqlite));

  expect(pgColumns).toStrictEqual(["id", "label", "amount_minor", "is_active", "created_at", "payload"]);
  expect(sqliteColumns).toStrictEqual(pgColumns);
});
