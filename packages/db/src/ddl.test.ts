import { expect, test } from "vitest";
import { createTableSql } from "./ddl.js";
import { defineTable } from "./dialect.js";

const demo = defineTable("demo_rows", {
  id: { kind: "uuid", primaryKey: true },
  label: { kind: "text", notNull: true },
  amount_minor: { kind: "money", notNull: true },
  is_active: { kind: "boolean", notNull: true, default: true },
  created_at: { kind: "timestamp", notNull: true },
  payload: { kind: "json" },
});

test("emits SQLite DDL, storing instants and booleans as integers", () => {
  expect(createTableSql(demo, "sqlite")).toBe(
    [
      'CREATE TABLE IF NOT EXISTS "demo_rows" (',
      '  "id" text PRIMARY KEY NOT NULL,',
      '  "label" text NOT NULL,',
      '  "amount_minor" integer NOT NULL,',
      '  "is_active" integer NOT NULL DEFAULT 1,',
      '  "created_at" integer NOT NULL,',
      '  "payload" text',
      ");",
    ].join("\n"),
  );
});

test("emits PostgreSQL DDL, using native timestamptz, boolean and jsonb", () => {
  expect(createTableSql(demo, "postgres")).toBe(
    [
      'CREATE TABLE IF NOT EXISTS "demo_rows" (',
      '  "id" text PRIMARY KEY NOT NULL,',
      '  "label" text NOT NULL,',
      '  "amount_minor" integer NOT NULL,',
      '  "is_active" boolean NOT NULL DEFAULT true,',
      '  "created_at" timestamptz NOT NULL,',
      '  "payload" jsonb',
      ");",
    ].join("\n"),
  );
});
