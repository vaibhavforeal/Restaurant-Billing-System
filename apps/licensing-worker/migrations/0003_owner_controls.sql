-- Owner control panel: per-restaurant module allowances decided by MasalaPOS, their history, and owner login sessions.
-- `overrides` holds only the owner's choices ({"kds": true, "reservations": false}); a module left out follows the plan.
CREATE TABLE owner_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(installation_id),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 120),
  overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides)),
  updated_at INTEGER NOT NULL
);
-- One row per module change; `allowed` NULL means "back to the plan's default". `revision` is the licence issued for it, if any.
CREATE TABLE owner_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  module_id TEXT NOT NULL,
  allowed INTEGER CHECK (allowed IS NULL OR allowed IN (0, 1)),
  revision INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX owner_events_installation ON owner_events(installation_id, id);
-- Only the SHA-256 of a session token is stored.
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Licences issued because the owner changed a restaurant's modules carry reason 'owner'. SQLite cannot widen a CHECK in place,
-- so the table is rebuilt; nothing references it.
CREATE TABLE licenses_new (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  revision INTEGER NOT NULL,
  plan TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, grace_until INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial','charge','owner')),
  razorpay_subscription_id TEXT, razorpay_payment_id TEXT UNIQUE,
  PRIMARY KEY (installation_id, revision)
);
INSERT INTO licenses_new SELECT installation_id, revision, plan, issued_at, expires_at, grace_until, envelope, reason, razorpay_subscription_id, razorpay_payment_id FROM licenses;
DROP TABLE licenses;
ALTER TABLE licenses_new RENAME TO licenses;
CREATE INDEX licenses_subscription ON licenses(razorpay_subscription_id, expires_at);
