import { PGlite } from "@electric-sql/pglite";
import { createClient, type Client as LibsqlClient } from "@libsql/client";
import { and, asc, eq, getTableColumns, gt, isNull, sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { createTableSql, type Dialect } from "./ddl.js";
import type { DualTable } from "./dialect.js";

export type Row = Record<string, unknown>;

/**
 * The narrow surface both stores expose.
 *
 * Sync code has to move rows between a terminal and the cloud without caring
 * which engine it is talking to, so the difference is confined to this file.
 */
export interface DbHandle {
  readonly dialect: Dialect;
  insert(table: DualTable, row: Row): Promise<void>;
  /** Insert, or replace the existing row with the same primary key. */
  upsert(table: DualTable, row: Row): Promise<void>;
  selectAll(table: DualTable): Promise<Row[]>;
  findById(table: DualTable, id: string): Promise<Row | null>;
  /** First row matching every column in `match`, or null. */
  findWhere(table: DualTable, match: Row): Promise<Row | null>;
  /** Outbox entries the cloud has not durably accepted yet, in creation order. */
  selectUnsynced(table: DualTable, limit: number): Promise<Row[]>;
  /** Rows changed after an HLC cursor, oldest first — the pull-down query. */
  selectSince(table: DualTable, since: string | null, limit: number): Promise<Row[]>;
  close(): Promise<void>;
}

/** Drizzle's builders are generic over statically-declared columns; our tables are
 *  built from a runtime spec, so the erased type is re-asserted here — in one place. */
type AnyRow = never;

/** Not every table is keyed on `id` — `sync_state` is keyed on `key`. */
function primaryKeyOf(table: DualTable): string {
  const found = Object.entries(table.spec).find(
    ([, spec]) => "primaryKey" in spec && spec.primaryKey,
  );
  if (!found) throw new Error(`Table "${table.name}" declares no primary key.`);
  return found[0];
}

export interface TerminalOptions {
  /** `:memory:` for tests, or `file:<path>` for a real terminal. */
  url: string;
  tables: DualTable[];
}

/** Open the per-terminal SQLite database — the source of truth during service. */
export async function openTerminal(options: TerminalOptions): Promise<DbHandle> {
  const client: LibsqlClient = createClient({ url: options.url });
  const db = drizzleLibsql(client);

  for (const table of options.tables) {
    await db.run(sql.raw(createTableSql(table, "sqlite")));
  }

  return {
    dialect: "sqlite",
    async insert(table, row) {
      await db.insert(table.sqlite).values(row as AnyRow);
    },
    async upsert(table, row) {
      const columns = getTableColumns(table.sqlite);
      await db
        .insert(table.sqlite)
        .values(row as AnyRow)
        .onConflictDoUpdate({ target: columns[primaryKeyOf(table)]!, set: row as AnyRow });
    },
    async selectAll(table) {
      return (await db.select().from(table.sqlite)) as Row[];
    },
    async findById(table, id) {
      const columns = getTableColumns(table.sqlite);
      const rows = await db.select().from(table.sqlite).where(eq(columns[primaryKeyOf(table)]!, id));
      return (rows[0] as Row | undefined) ?? null;
    },
    async findWhere(table, match) {
      const columns = getTableColumns(table.sqlite);
      const conditions = Object.entries(match).map(([column, value]) => eq(columns[column]!, value));
      const rows = await db.select().from(table.sqlite).where(and(...conditions)).limit(1);
      return (rows[0] as Row | undefined) ?? null;
    },
    async selectUnsynced(table, limit) {
      const columns = getTableColumns(table.sqlite);
      return (await db
        .select()
        .from(table.sqlite)
        .where(isNull(columns.synced_at!))
        .orderBy(asc(columns[primaryKeyOf(table)]!))
        .limit(limit)) as Row[];
    },
    async selectSince(table, since, limit) {
      const columns = getTableColumns(table.sqlite);
      const query = db.select().from(table.sqlite);
      return (await (since === null ? query : query.where(gt(columns.hlc!, since)))
        .orderBy(asc(columns.hlc!))
        .limit(limit)) as Row[];
    },
    async close() {
      client.close();
    },
  };
}

export interface CloudOptions {
  /** Omit for an in-process PGlite instance (tests, local dev). */
  dataDir?: string;
  tables: DualTable[];
}

/** Open the cloud PostgreSQL database — the system of record for the business. */
export async function openCloud(options: CloudOptions): Promise<DbHandle> {
  const pglite = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  const db = drizzlePglite(pglite);

  for (const table of options.tables) {
    await db.execute(sql.raw(createTableSql(table, "postgres")));
  }

  return {
    dialect: "postgres",
    async insert(table, row) {
      await db.insert(table.pg).values(row as AnyRow);
    },
    async upsert(table, row) {
      const columns = getTableColumns(table.pg);
      await db
        .insert(table.pg)
        .values(row as AnyRow)
        .onConflictDoUpdate({ target: columns[primaryKeyOf(table)]!, set: row as AnyRow });
    },
    async selectAll(table) {
      return (await db.select().from(table.pg)) as Row[];
    },
    async findById(table, id) {
      const columns = getTableColumns(table.pg);
      const rows = await db.select().from(table.pg).where(eq(columns[primaryKeyOf(table)]!, id));
      return (rows[0] as Row | undefined) ?? null;
    },
    async findWhere(table, match) {
      const columns = getTableColumns(table.pg);
      const conditions = Object.entries(match).map(([column, value]) => eq(columns[column]!, value));
      const rows = await db.select().from(table.pg).where(and(...conditions)).limit(1);
      return (rows[0] as Row | undefined) ?? null;
    },
    async selectUnsynced(table, limit) {
      const columns = getTableColumns(table.pg);
      return (await db
        .select()
        .from(table.pg)
        .where(isNull(columns.synced_at!))
        .orderBy(asc(columns[primaryKeyOf(table)]!))
        .limit(limit)) as Row[];
    },
    async selectSince(table, since, limit) {
      const columns = getTableColumns(table.pg);
      const query = db.select().from(table.pg);
      return (await (since === null ? query : query.where(gt(columns.hlc!, since)))
        .orderBy(asc(columns.hlc!))
        .limit(limit)) as Row[];
    },
    async close() {
      await pglite.close();
    },
  };
}
