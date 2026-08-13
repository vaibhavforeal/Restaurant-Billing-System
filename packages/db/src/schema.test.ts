import { expect, test } from "vitest";
import { LOCAL_ONLY_TABLES, SYNCED_TABLES, schema } from "./schema.js";

test("every synced table carries the replication envelope", () => {
  for (const table of SYNCED_TABLES) {
    expect({ table: table.name, columns: Object.keys(table.spec) }).toStrictEqual({
      table: table.name,
      columns: expect.arrayContaining(["id", "org_id", "created_at", "updated_at", "hlc", "deleted_at"]),
    });
  }
});

test("the outbox and sync cursor stay local — they must never replicate", () => {
  const localNames = LOCAL_ONLY_TABLES.map((t) => t.name);

  expect(localNames).toStrictEqual(["outbox", "sync_state"]);
  expect(SYNCED_TABLES.map((t) => t.name)).not.toContain("outbox");
});

test("money is never stored as a float anywhere in the schema", () => {
  const floatColumns = Object.values(schema)
    .flatMap((table) =>
      Object.entries(table.spec).map(([column, spec]) => ({ table: table.name, column, kind: spec.kind })),
    )
    .filter(({ column, kind }) => /amount|price|total|paise/.test(column) && kind !== "money");

  expect(floatColumns).toStrictEqual([]);
});
