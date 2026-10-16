CREATE TABLE restaurant_feature_policies (
  organization_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}', updated_at INTEGER,
  PRIMARY KEY (organization_id, outlet_id)
);
CREATE TABLE owner_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE restaurant_feature_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  feature_id TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL, occurred_at INTEGER NOT NULL
);
