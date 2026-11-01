-- Preserve the existing support graph while making the counter optional.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE support_chats_new (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  installation_id TEXT REFERENCES installations(installation_id),
  visitor_name TEXT CHECK (visitor_name IS NULL OR length(visitor_name) BETWEEN 1 AND 80),
  visitor_phone TEXT CHECK (visitor_phone IS NULL OR length(visitor_phone) BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
  assignee_id TEXT REFERENCES staff_users(id),
  ticket_id TEXT REFERENCES tickets(id),
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  closed_at INTEGER
);

INSERT INTO support_chats_new (id, number, customer_id, installation_id, visitor_name, visitor_phone, status, assignee_id, ticket_id, created_at, last_message_at, closed_at) SELECT id, number, customer_id, installation_id, visitor_name, visitor_phone, status, assignee_id, ticket_id, created_at, last_message_at, closed_at FROM support_chats;

DROP TABLE support_chats;

ALTER TABLE support_chats_new RENAME TO support_chats;

CREATE INDEX support_chats_status ON support_chats(status, last_message_at);

CREATE INDEX support_chats_installation ON support_chats(installation_id, created_at);

CREATE INDEX support_chats_customer ON support_chats(customer_id, created_at);

CREATE TABLE remote_sessions_new (
  id TEXT PRIMARY KEY,
  installation_id TEXT REFERENCES installations(installation_id),
  customer_id TEXT REFERENCES customers(id),
  chat_id TEXT REFERENCES support_chats(id),
  requested_by TEXT NOT NULL REFERENCES staff_users(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  mode_requested TEXT NOT NULL CHECK (mode_requested IN ('view', 'control')),
  mode TEXT CHECK (mode IS NULL OR mode IN ('view', 'control')),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'denied', 'expired', 'approved', 'active', 'ended')),
  approved_by_name TEXT CHECK (approved_by_name IS NULL OR length(approved_by_name) <= 80),
  agent_token_hash TEXT,
  requested_at INTEGER NOT NULL,
  answered_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT
);

INSERT INTO remote_sessions_new (id, installation_id, customer_id, chat_id, requested_by, reason, mode_requested, mode, status, approved_by_name, agent_token_hash, requested_at, answered_at, started_at, ended_at, end_reason) SELECT id, installation_id, customer_id, chat_id, requested_by, reason, mode_requested, mode, status, approved_by_name, agent_token_hash, requested_at, answered_at, started_at, ended_at, end_reason FROM remote_sessions;

DROP TABLE remote_sessions;

ALTER TABLE remote_sessions_new RENAME TO remote_sessions;

CREATE INDEX remote_sessions_installation ON remote_sessions(installation_id, requested_at);

CREATE INDEX remote_sessions_status ON remote_sessions(status);

ALTER TABLE remote_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'in_app' CHECK (origin IN ('in_app','connector'));

ALTER TABLE remote_sessions ADD COLUMN elevated INTEGER NOT NULL DEFAULT 0 CHECK (elevated IN (0,1));

ALTER TABLE remote_sessions ADD COLUMN admin_prompts INTEGER NOT NULL DEFAULT 0 CHECK (admin_prompts IN (0,1));

ALTER TABLE remote_sessions ADD COLUMN expires_at INTEGER;

CREATE TABLE connector_tokens (
  token_hash TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE,
  session_id TEXT NOT NULL REFERENCES remote_sessions(id),
  chat_id TEXT NOT NULL REFERENCES support_chats(id),
  kind TEXT NOT NULL CHECK (kind IN ('download','consent')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX connector_tokens_session ON connector_tokens(session_id);
CREATE UNIQUE INDEX connector_open_chat ON remote_sessions(chat_id) WHERE origin = 'connector' AND status IN ('requested','approved','active');
CREATE UNIQUE INDEX connector_open_installation ON remote_sessions(installation_id) WHERE status IN ('requested','approved','active') AND installation_id IS NOT NULL;

-- SQLite retains deferred DROP TABLE violations even after replacing the parent.
-- Validate the rebuilt graph before clearing that deferred counter; any violation rolls back the entire migration.
CREATE TEMP TABLE connector_fk_check (violations INTEGER CHECK (violations = 0));
INSERT INTO connector_fk_check SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE connector_fk_check;
PRAGMA defer_foreign_keys = OFF;
