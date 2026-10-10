CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL, organization_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  trial_started_at INTEGER, contact_email TEXT, created_at INTEGER NOT NULL,
  revision_floor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE subscriptions (
  razorpay_subscription_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  plan TEXT NOT NULL CHECK (plan IN ('basic','pro')),
  period TEXT NOT NULL CHECK (period IN ('monthly','yearly')),
  status TEXT NOT NULL, current_period_end INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE licenses (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  revision INTEGER NOT NULL,
  plan TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, grace_until INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('trial','charge')),
  razorpay_subscription_id TEXT, razorpay_payment_id TEXT UNIQUE,
  PRIMARY KEY (installation_id, revision)
);
CREATE INDEX licenses_subscription ON licenses(razorpay_subscription_id, expires_at);
CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY, type TEXT NOT NULL, outcome TEXT NOT NULL, received_at INTEGER NOT NULL
);
