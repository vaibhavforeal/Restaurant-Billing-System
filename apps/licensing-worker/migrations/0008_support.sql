-- MasalaPOS live support: chats between a restaurant's counter and support staff, the one-time links a counter mints to open them,
-- and consent-based remote sessions.

-- A chat belongs to one counter (installation) and its customer. The restaurant writes from the browser the counter opened;
-- support staff answer from the portal. At most one chat per counter is open at a time (enforced by the code that creates them).
CREATE TABLE support_chats (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  visitor_name TEXT CHECK (visitor_name IS NULL OR length(visitor_name) BETWEEN 1 AND 80),
  visitor_phone TEXT CHECK (visitor_phone IS NULL OR length(visitor_phone) BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
  assignee_id TEXT REFERENCES staff_users(id),
  ticket_id TEXT REFERENCES tickets(id),
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX support_chats_status ON support_chats(status, last_message_at);
CREATE INDEX support_chats_installation ON support_chats(installation_id, created_at);
CREATE INDEX support_chats_customer ON support_chats(customer_id, created_at);

-- author_id is the staff member for 'staff' messages and NULL otherwise ('customer' is whoever is at the restaurant, 'system' is the service).
CREATE TABLE support_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES support_chats(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('customer', 'staff', 'system')),
  author_id TEXT REFERENCES staff_users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL
);
CREATE INDEX support_chat_messages_chat ON support_chat_messages(chat_id, id);

-- A one-time link the counter asks for (with its installation secret) and opens in the browser. Only the SHA-256 of the token is kept.
CREATE TABLE support_links (
  token_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- The browser session a used link turns into (the mp_support cookie, hashed). It speaks for the counter's chats only.
CREATE TABLE support_visitors (
  session_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX support_visitors_expiry ON support_visitors(expires_at);

-- Remote access to a counter's PC. Staff ask; someone at the PC allows (view only, or view and control) or refuses. Nothing starts without that answer.
CREATE TABLE remote_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
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
CREATE INDEX remote_sessions_installation ON remote_sessions(installation_id, requested_at);
CREATE INDEX remote_sessions_status ON remote_sessions(status);
