export { openCloud, openTerminal, type CloudOptions, type DbHandle, type Row, type TerminalOptions } from "./client.js";
export { createTableSql, type Dialect } from "./ddl.js";
export { defineTable, type ColumnSpec, type DualTable, type TableSpec } from "./dialect.js";
export { createRepository, type Repository, type RepositoryOptions } from "./repository.js";
export { createAuthService, type AuthService, type LoginFailure, type LoginResult, type Session } from "./auth.js";
export { createSyncAgent, type SyncAgent, type SyncAgentOptions } from "./sync-agent.js";
export { createDirectTransport } from "./transport-direct.js";
export { reviveRow, tableByName } from "./serialize.js";
export {
  CLOUD_TABLES,
  LOCAL_ONLY_TABLES,
  SYNCED_TABLES,
  TERMINAL_TABLES,
  audit_log,
  menu_categories,
  organizations,
  outbox,
  outlets,
  roles,
  schema,
  sync_state,
  user_outlet_access,
  users,
} from "./schema.js";
