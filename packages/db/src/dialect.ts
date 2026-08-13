import {
  boolean as pgBoolean,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  uuid as pgUuid,
} from "drizzle-orm/pg-core";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";

/**
 * A dialect-neutral column vocabulary.
 *
 * Deliberately small: every kind here has a lossless representation in *both*
 * SQLite and PostgreSQL, so terminal and cloud always agree on what a value
 * means. Anything that cannot round-trip identically does not belong here.
 */
export type ColumnSpec =
  /** UUIDv7 primary/foreign keys — stored as text so the bytes match everywhere. */
  | { kind: "uuid"; primaryKey?: boolean; notNull?: boolean; references?: () => unknown }
  | { kind: "text"; notNull?: boolean; default?: string; primaryKey?: boolean }
  | { kind: "integer"; notNull?: boolean; default?: number }
  /** Money in minor units (paise). Never a float — rounding drift is a billing bug. */
  | { kind: "money"; notNull?: boolean; default?: number }
  | { kind: "boolean"; notNull?: boolean; default?: boolean }
  /** Epoch-millisecond instants; SQLite stores an integer, Postgres a timestamptz. */
  | { kind: "timestamp"; notNull?: boolean }
  | { kind: "json"; notNull?: boolean };

export type TableSpec = Record<string, ColumnSpec>;

function pgColumn(name: string, spec: ColumnSpec) {
  const base = (() => {
    switch (spec.kind) {
      case "uuid":
      case "text":
        return pgText(name);
      case "integer":
      case "money":
        return pgInteger(name);
      case "boolean":
        return pgBoolean(name);
      case "timestamp":
        return pgTimestamp(name, { withTimezone: true, mode: "date" });
      case "json":
        return pgJsonb(name);
    }
  })();

  let column = base as ReturnType<typeof pgText>;
  if ("default" in spec && spec.default !== undefined) column = column.default(spec.default as never);
  if (spec.notNull) column = column.notNull();
  if ("primaryKey" in spec && spec.primaryKey) column = column.primaryKey();
  return column;
}

function sqliteColumn(name: string, spec: ColumnSpec) {
  const base = (() => {
    switch (spec.kind) {
      case "uuid":
      case "text":
        return sqliteText(name);
      case "integer":
      case "money":
        return sqliteInteger(name);
      case "boolean":
        return sqliteInteger(name, { mode: "boolean" });
      case "timestamp":
        return sqliteInteger(name, { mode: "timestamp_ms" });
      case "json":
        return sqliteText(name, { mode: "json" });
    }
  })();

  let column = base as ReturnType<typeof sqliteText>;
  if ("default" in spec && spec.default !== undefined) column = column.default(spec.default as never);
  if (spec.notNull) column = column.notNull();
  if ("primaryKey" in spec && spec.primaryKey) column = column.primaryKey();
  return column;
}

export interface DualTable {
  name: string;
  spec: TableSpec;
  pg: ReturnType<typeof pgTable>;
  sqlite: ReturnType<typeof sqliteTable>;
}

/**
 * Compile one table definition into both dialects.
 *
 * This is the hinge of the hybrid architecture (PROJECT_PLAN §5.3): domain code
 * is written once and runs against the terminal's SQLite and the cloud's
 * Postgres, so the two can never silently drift apart.
 */
export function defineTable<S extends TableSpec>(name: string, spec: S): DualTable {
  const pgColumns = Object.fromEntries(
    Object.entries(spec).map(([column, columnSpec]) => [column, pgColumn(column, columnSpec)]),
  );
  const sqliteColumns = Object.fromEntries(
    Object.entries(spec).map(([column, columnSpec]) => [column, sqliteColumn(column, columnSpec)]),
  );

  return {
    name,
    spec,
    pg: pgTable(name, pgColumns),
    sqlite: sqliteTable(name, sqliteColumns),
  };
}
