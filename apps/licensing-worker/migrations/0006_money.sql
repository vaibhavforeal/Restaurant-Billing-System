-- MasalaPOS Portal, part 3: payments against orders, Razorpay payment links, and GST tax invoices.

-- Only a cleared payment counts towards an order's total; a cheque waits as 'pending' until it clears. A Razorpay payment is recorded
-- once whatever the webhook does, by its payment id.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank', 'upi', 'cheque', 'card', 'razorpay')),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  status TEXT NOT NULL CHECK (status IN ('pending', 'cleared', 'bounced')),
  received_at INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  razorpay_payment_id TEXT UNIQUE,
  recorded_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX payments_order ON payments(order_id);
CREATE INDEX payments_received ON payments(received_at);

-- One row per link sent. Razorpay never accepts a reference id twice, so each new link for an order is a new attempt.
CREATE TABLE payment_links (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  attempt INTEGER NOT NULL,
  reference_id TEXT NOT NULL UNIQUE,
  short_url TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL,
  expire_by INTEGER,
  created_by TEXT REFERENCES staff_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (order_id, attempt)
);

-- A tax invoice never changes once issued: the seller, buyer and lines are copied in as they were. Numbers run without gaps within
-- a financial year ("26-27"); an order has at most one invoice that is not cancelled.
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  fy TEXT NOT NULL,
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE CHECK (length(number) <= 16),
  issued_at INTEGER NOT NULL,
  seller TEXT NOT NULL CHECK (json_valid(seller)),
  buyer TEXT NOT NULL CHECK (json_valid(buyer)),
  lines TEXT NOT NULL CHECK (json_valid(lines)),
  place_of_supply TEXT NOT NULL,
  intra_state INTEGER NOT NULL CHECK (intra_state IN (0, 1)),
  subtotal_paise INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL,
  sgst_paise INTEGER NOT NULL,
  igst_paise INTEGER NOT NULL,
  total_paise INTEGER NOT NULL,
  issued_by TEXT REFERENCES staff_users(id),
  cancelled_at INTEGER,
  cancelled_by TEXT REFERENCES staff_users(id),
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300),
  UNIQUE (fy, seq)
);
CREATE UNIQUE INDEX invoices_live_per_order ON invoices(order_id) WHERE cancelled_at IS NULL;
CREATE INDEX invoices_customer ON invoices(customer_id);
CREATE INDEX invoices_issued ON invoices(issued_at);
