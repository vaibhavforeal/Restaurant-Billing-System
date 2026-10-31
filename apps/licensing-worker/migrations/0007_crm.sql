-- ForkFlow Portal, part 4: leads and their pipeline, follow-ups on leads and customers, and support tickets.

-- A restaurant that might buy. It becomes a customer when converted (stage 'won'); `stage_changed_at` dates the pipeline.
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 120),
  contact_name TEXT CHECK (contact_name IS NULL OR length(contact_name) <= 80),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 20),
  email TEXT CHECK (email IS NULL OR length(email) <= 254),
  city TEXT CHECK (city IS NULL OR length(city) <= 80),
  state_code TEXT CHECK (state_code IS NULL OR length(state_code) = 2),
  source TEXT NOT NULL CHECK (source IN ('walk_in', 'referral', 'website', 'call', 'partner', 'event', 'other')),
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'demo_scheduled', 'demo_done', 'proposal', 'won', 'lost')),
  lost_reason TEXT CHECK (lost_reason IS NULL OR length(lost_reason) <= 300),
  expected_plan TEXT CHECK (expected_plan IS NULL OR expected_plan IN ('basic', 'pro')),
  expected_outlets INTEGER CHECK (expected_outlets IS NULL OR expected_outlets BETWEEN 1 AND 500),
  estimated_value_paise INTEGER CHECK (estimated_value_paise IS NULL OR estimated_value_paise >= 0),
  owner_id TEXT REFERENCES staff_users(id),
  customer_id TEXT REFERENCES customers(id),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stage_changed_at INTEGER NOT NULL,
  closed_at INTEGER,
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);
CREATE INDEX leads_owner ON leads(owner_id, stage);
CREATE INDEX leads_created ON leads(created_at);

-- Something someone must do by a date, about exactly one lead or one customer.
CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  customer_id TEXT REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'visit', 'demo', 'whatsapp', 'email', 'renewal', 'payment', 'other')),
  due_at INTEGER NOT NULL,
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  owner_id TEXT NOT NULL REFERENCES staff_users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) <= 500),
  done_at INTEGER,
  done_by TEXT REFERENCES staff_users(id),
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((lead_id IS NULL) <> (customer_id IS NULL))
);
CREATE INDEX follow_ups_owner ON follow_ups(owner_id, status, due_at);
CREATE INDEX follow_ups_lead ON follow_ups(lead_id);
CREATE INDEX follow_ups_customer ON follow_ups(customer_id);

-- A support case. `number` is what customers quote on the phone (T-1001), the next one worked out by the INSERT.
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  installation_id TEXT REFERENCES installations(installation_id),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  description TEXT CHECK (description IS NULL OR length(description) <= 4000),
  category TEXT NOT NULL CHECK (category IN ('activation', 'licence', 'billing', 'printing', 'hardware', 'training', 'bug', 'other')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  assignee_id TEXT REFERENCES staff_users(id),
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX tickets_status ON tickets(status, priority);
CREATE INDEX tickets_customer ON tickets(customer_id);
CREATE INDEX tickets_assignee ON tickets(assignee_id, status);

CREATE TABLE ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  author_id TEXT REFERENCES staff_users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL
);
CREATE INDEX ticket_comments_ticket ON ticket_comments(ticket_id, id);
