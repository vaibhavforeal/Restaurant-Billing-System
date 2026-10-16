CREATE TABLE restaurant_staff (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id), user_id TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL, synced_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, user_id)
);
CREATE TABLE restaurant_staff_permissions (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id), user_id TEXT NOT NULL,
  overrides TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, user_id)
);
CREATE TABLE restaurant_staff_permission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, installation_id TEXT NOT NULL, user_id TEXT NOT NULL,
  overrides TEXT NOT NULL, revision INTEGER NOT NULL, occurred_at INTEGER NOT NULL
);
