import type { Row } from "./client.js";
import type { DualTable } from "./dialect.js";
import { schema } from "./schema.js";

const BY_NAME = new Map(Object.values(schema).map((table) => [table.name, table]));

export function tableByName(name: string): DualTable {
  const table = BY_NAME.get(name);
  if (!table) throw new Error(`Unknown entity "${name}" — not part of the schema.`);
  return table;
}

/**
 * Restore a row that has been through JSON.
 *
 * An outbox payload is stored as JSON, so `Date` instants arrive back as ISO
 * strings. Postgres' `timestamptz` columns reject those, so the table spec —
 * the same one that generated the columns — tells us which fields to rebuild.
 */
export function reviveRow(table: DualTable, raw: Row): Row {
  const revived: Row = {};
  for (const [column, value] of Object.entries(raw)) {
    const spec = table.spec[column];
    revived[column] =
      spec?.kind === "timestamp" && typeof value === "string" ? new Date(value) : value;
  }
  return revived;
}
