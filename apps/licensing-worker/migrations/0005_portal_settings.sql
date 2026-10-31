-- MasalaPOS Portal, part 2: one row of portal settings (the seller's GST details for invoices, invoice wording, the price list),
-- kept as JSON that the Worker validates, so adding a setting needs no migration.
CREATE TABLE portal_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES staff_users(id)
);
