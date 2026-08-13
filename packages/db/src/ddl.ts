import type { ColumnSpec, DualTable } from "./dialect.js";

export type Dialect = "sqlite" | "postgres";

const SQL_TYPES: Record<Dialect, Record<ColumnSpec["kind"], string>> = {
  sqlite: {
    uuid: "text",
    text: "text",
    integer: "integer",
    money: "integer",
    boolean: "integer", // 0/1
    timestamp: "integer", // epoch millis
    json: "text",
  },
  postgres: {
    uuid: "text",
    text: "text",
    integer: "integer",
    money: "integer",
    boolean: "boolean",
    timestamp: "timestamptz",
    json: "jsonb",
  },
};

function literal(value: string | number | boolean, dialect: Dialect): string {
  if (typeof value === "boolean") {
    if (dialect === "sqlite") return value ? "1" : "0";
    return value ? "true" : "false";
  }
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function columnSql(name: string, spec: ColumnSpec, dialect: Dialect): string {
  const parts = [`"${name}"`, SQL_TYPES[dialect][spec.kind]];
  if ("primaryKey" in spec && spec.primaryKey) parts.push("PRIMARY KEY");
  if (spec.notNull || ("primaryKey" in spec && spec.primaryKey)) parts.push("NOT NULL");
  if ("default" in spec && spec.default !== undefined) {
    parts.push(`DEFAULT ${literal(spec.default, dialect)}`);
  }
  return `  ${parts.join(" ")}`;
}

/**
 * Render a table definition as `CREATE TABLE` for one dialect.
 *
 * A terminal must be able to bring up its own SQLite file on first boot with no
 * network and no migration tooling, so the DDL is derived from the same spec
 * that produces the Drizzle tables rather than kept in a parallel SQL file.
 */
export function createTableSql(table: DualTable, dialect: Dialect): string {
  const columns = Object.entries(table.spec).map(([name, spec]) => columnSql(name, spec, dialect));
  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns.join(",\n")}\n);`;
}
