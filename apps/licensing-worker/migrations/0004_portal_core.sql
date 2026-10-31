-- MasalaPOS Portal, part 1: staff accounts, customers, orders and the activity log. A counter is enrolled against an order
-- (Customer ID + Order ID at setup) instead of getting a trial on first contact, and self-serve subscriptions are gone.

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('admin', 'sales', 'accounts', 'support')),
  -- "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>"
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Only the SHA-256 of a session token is stored.
CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX staff_sessions_user ON staff_sessions(user_id);

-- `code` is the Customer ID a restaurant types at setup (FC-XXXX-XXX). `owner_id` is the sales rep the customer belongs to.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 120),
  contact_name TEXT CHECK (contact_name IS NULL OR length(contact_name) <= 80),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 20),
  email TEXT CHECK (email IS NULL OR length(email) <= 254),
  gstin TEXT CHECK (gstin IS NULL OR length(gstin) = 15),
  address TEXT CHECK (address IS NULL OR length(address) <= 300),
  city TEXT CHECK (city IS NULL OR length(city) <= 80),
  -- GST state code ("27" Maharashtra); decides CGST+SGST or IGST on invoices.
  state_code TEXT CHECK (state_code IS NULL OR length(state_code) = 2),
  pincode TEXT CHECK (pincode IS NULL OR length(pincode) = 6),
  owner_id TEXT REFERENCES staff_users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX customers_owner ON customers(owner_id);

-- `code` is the Order ID. A new or trial order sells `outlets` seats, each taken by one counter when it enrols; `seats_used` can never
-- pass `outlets`, so two counters racing for the last seat cannot both win (the losing batch fails and rolls back). A renewal order
-- sells no seats: it extends the installations listed in order_installations. Trial orders run for `term_days`, others `term_months`.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  owner_id TEXT REFERENCES staff_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('new', 'renewal', 'trial')),
  plan TEXT NOT NULL CHECK (plan IN ('basic', 'pro')),
  term_months INTEGER CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 60),
  term_days INTEGER CHECK (term_days IS NULL OR term_days BETWEEN 1 AND 90),
  outlets INTEGER NOT NULL CHECK (outlets BETWEEN 0 AND 500),
  seats_used INTEGER NOT NULL DEFAULT 0,
  max_devices INTEGER NOT NULL CHECK (max_devices BETWEEN 1 AND 100),
  -- The modules allowed or blocked beyond the plan ({"kds": true}); copied to each counter's owner_settings when it enrols.
  modules TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(modules)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'paid', 'cancelled')),
  -- An admin may let a confirmed, unpaid order activate until this date; licences issued on credit end there.
  credit_until INTEGER,
  credit_approved_by TEXT REFERENCES staff_users(id),
  credit_approved_at INTEGER,
  subtotal_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  paid_at INTEGER,
  cancelled_at INTEGER,
  CHECK (seats_used >= 0 AND seats_used <= outlets),
  CHECK ((term_months IS NULL) <> (term_days IS NULL)),
  CHECK ((kind = 'trial') = (term_days IS NOT NULL)),
  CHECK (kind <> 'renewal' OR outlets = 0)
);
CREATE INDEX orders_customer ON orders(customer_id);
CREATE INDEX orders_owner ON orders(owner_id);
CREATE INDEX orders_status ON orders(status);

-- The licence line is generated from the order; extra lines (installation, training) are typed in. Prices exclude GST.
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('licence', 'extra')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  sac TEXT NOT NULL CHECK (length(sac) BETWEEN 4 AND 8),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  -- Basis points: 1800 is 18%.
  gst_rate_bp INTEGER NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 2800)
);
CREATE INDEX order_lines_order ON order_lines(order_id, position);

CREATE TABLE order_installations (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  PRIMARY KEY (order_id, installation_id)
);

-- Every change made in the portal, by a webhook or by a counter enrolling. `actor_id` is NULL when the system acted.
-- `customer_id` lets a customer's page show its whole history and keeps sales reps to their own customers.
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT REFERENCES staff_users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  summary TEXT NOT NULL,
  data TEXT CHECK (data IS NULL OR json_valid(data))
);
CREATE INDEX activity_entity ON activity_log(entity_type, entity_id, id);
CREATE INDEX activity_customer ON activity_log(customer_id, id);
CREATE INDEX activity_at ON activity_log(at);

-- Self-serve checkout and the shared owner password are gone.
DROP TABLE subscriptions;
DROP TABLE subscribe_sessions;
DROP TABLE owner_sessions;

-- installations is referenced by several tables, so it is only ever altered in place, never rebuilt.
ALTER TABLE installations ADD COLUMN customer_id TEXT REFERENCES customers(id);
-- The new or trial order whose seat this counter holds; NULL until it enrols, and again once a seat is released.
ALTER TABLE installations ADD COLUMN order_id TEXT REFERENCES orders(id);
ALTER TABLE installations ADD COLUMN max_devices INTEGER;
ALTER TABLE installations ADD COLUMN outlet_name TEXT;
ALTER TABLE installations ADD COLUMN activated_at INTEGER;
ALTER TABLE installations ADD COLUMN last_seen_at INTEGER;
ALTER TABLE installations ADD COLUMN app_version TEXT;
ALTER TABLE installations DROP COLUMN trial_started_at;
ALTER TABLE installations DROP COLUMN contact_email;
CREATE INDEX installations_customer ON installations(customer_id);
CREATE INDEX installations_order ON installations(order_id);

ALTER TABLE owner_events ADD COLUMN actor_id TEXT REFERENCES staff_users(id);

-- Licences now come from orders ('order'), a staff member's adjustment ('manual') or a module change ('owner'). One payment can renew
-- several outlets, so payment ids live with payments, not here. Nothing may reference licenses, so it can be rebuilt.
CREATE TABLE licenses_new (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  revision INTEGER NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('basic', 'pro')),
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, grace_until INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('order', 'manual', 'owner')),
  order_id TEXT REFERENCES orders(id),
  PRIMARY KEY (installation_id, revision)
);
INSERT INTO licenses_new SELECT installation_id, revision, plan, issued_at, expires_at, grace_until, envelope,
  CASE reason WHEN 'owner' THEN 'owner' ELSE 'manual' END, NULL FROM licenses;
DROP TABLE licenses;
ALTER TABLE licenses_new RENAME TO licenses;
CREATE INDEX licenses_order ON licenses(order_id);
CREATE INDEX licenses_expiry ON licenses(expires_at);
