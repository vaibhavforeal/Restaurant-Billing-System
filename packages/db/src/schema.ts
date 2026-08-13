import { defineTable, type ColumnSpec, type DualTable, type TableSpec } from "./dialect.js";

/**
 * The replication envelope every synced row carries (PROJECT_PLAN §6).
 *
 * `hlc` is what makes cross-terminal conflict resolution decidable; `deleted_at`
 * makes deletes replicable (a row that vanished locally is indistinguishable
 * from one that never arrived); `synced_at` is the terminal's own bookkeeping.
 */
const envelope = {
  id: { kind: "uuid", primaryKey: true },
  org_id: { kind: "uuid", notNull: true },
  created_at: { kind: "timestamp", notNull: true },
  updated_at: { kind: "timestamp", notNull: true },
  hlc: { kind: "text", notNull: true },
  synced_at: { kind: "timestamp" },
  deleted_at: { kind: "timestamp" },
} satisfies TableSpec;

/** A table that replicates between terminal and cloud. */
function syncedTable(name: string, columns: Record<string, ColumnSpec>): DualTable {
  return defineTable(name, { ...envelope, ...columns });
}

// ── Identity & tenancy ────────────────────────────────────────────────────────

export const organizations = syncedTable("organizations", {
  name: { kind: "text", notNull: true },
});

export const outlets = syncedTable("outlets", {
  name: { kind: "text", notNull: true },
  /** Drives the smart per-outlet-type defaults in guided setup (PROJECT_PLAN §2.9). */
  outlet_type: { kind: "text", notNull: true, default: "cafe" },
  timezone: { kind: "text", notNull: true, default: "Asia/Kolkata" },
});

export const roles = syncedTable("roles", {
  name: { kind: "text", notNull: true },
  /** Permission slugs, e.g. ["bill.void", "discount.apply"]. */
  permissions: { kind: "json", notNull: true },
  /** Caps a role can never exceed regardless of grants, e.g. max discount %. */
  limits: { kind: "json" },
});

export const users = syncedTable("users", {
  email: { kind: "text", notNull: true },
  name: { kind: "text", notNull: true },
  /** scrypt digest — never a reversible encoding. */
  password_hash: { kind: "text", notNull: true },
  is_active: { kind: "boolean", notNull: true, default: true },
});

export const user_outlet_access = syncedTable("user_outlet_access", {
  user_id: { kind: "uuid", notNull: true },
  outlet_id: { kind: "uuid", notNull: true },
  role_id: { kind: "uuid", notNull: true },
});

// ── Menu (the config that flows cloud → terminal) ─────────────────────────────

export const menu_categories = syncedTable("menu_categories", {
  outlet_id: { kind: "uuid", notNull: true },
  name: { kind: "text", notNull: true },
  sort_order: { kind: "integer", notNull: true, default: 0 },
  is_active: { kind: "boolean", notNull: true, default: true },
});

// ── Audit ─────────────────────────────────────────────────────────────────────

export const audit_log = syncedTable("audit_log", {
  outlet_id: { kind: "uuid" },
  user_id: { kind: "uuid" },
  /** e.g. "bill.void", "discount.apply", "user.login". */
  action: { kind: "text", notNull: true },
  entity: { kind: "text" },
  entity_id: { kind: "uuid" },
  detail: { kind: "json" },
});

// ── Local-only bookkeeping (never replicated) ────────────────────────────────

/**
 * The change log every local mutation appends to (PROJECT_PLAN §5.3).
 * Drained in `id` order, which is creation order because ids are UUIDv7.
 */
export const outbox = defineTable("outbox", {
  id: { kind: "uuid", primaryKey: true },
  org_id: { kind: "uuid", notNull: true },
  entity: { kind: "text", notNull: true },
  entity_id: { kind: "uuid", notNull: true },
  op: { kind: "text", notNull: true }, // upsert | delete
  payload: { kind: "json", notNull: true },
  hlc: { kind: "text", notNull: true },
  created_at: { kind: "timestamp", notNull: true },
  /** Null until the cloud has durably accepted this change. */
  synced_at: { kind: "timestamp" },
});

/** Key/value cursor store: last pulled HLC per entity, terminal identity, etc. */
export const sync_state = defineTable("sync_state", {
  key: { kind: "text", primaryKey: true },
  value: { kind: "text", notNull: true },
  updated_at: { kind: "timestamp", notNull: true },
});

export const SYNCED_TABLES: DualTable[] = [
  organizations,
  outlets,
  roles,
  users,
  user_outlet_access,
  menu_categories,
  audit_log,
];

export const LOCAL_ONLY_TABLES: DualTable[] = [outbox, sync_state];

/** Everything a terminal creates on first boot. */
export const TERMINAL_TABLES: DualTable[] = [...SYNCED_TABLES, ...LOCAL_ONLY_TABLES];

/** Everything the cloud holds — the outbox and cursor are terminal-private. */
export const CLOUD_TABLES: DualTable[] = SYNCED_TABLES;

export const schema = {
  organizations,
  outlets,
  roles,
  users,
  user_outlet_access,
  menu_categories,
  audit_log,
  outbox,
  sync_state,
} as const;
