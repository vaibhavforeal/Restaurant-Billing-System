-- The AI assistant, run by MasalaPOS: counters send their AI requests here, and this service forwards them with MasalaPOS's own provider key.
-- A counter may use it only once MasalaPOS switches it on (no row = off), and only up to its daily limit. The switch belongs to the seat:
-- `order_id` is the order whose seat the counter held when it was switched on, and it counts only while the counter still holds that seat
-- (a released counter, or one re-activated on another order, is off until switched on again).
CREATE TABLE ai_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(installation_id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  order_id TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 40 CHECK (daily_limit BETWEEN 1 AND 1000),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
-- Successful AI requests per counter per UTC day (`day` is YYYY-MM-DD), with the provider's token counts, for limits and pricing.
CREATE TABLE ai_usage (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, day)
);
