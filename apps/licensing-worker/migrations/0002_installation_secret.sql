ALTER TABLE installations ADD COLUMN secret_hash TEXT;
CREATE TABLE subscribe_sessions (
  token_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
