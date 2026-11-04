-- Where the supply was made and how its GST was split, fixed when an order is confirmed, so the order and its invoice keep both even if
-- the customer's (or MasalaPOS's) state changes later. `supply_state` is the buyer's GST state code; `intra_state` is 1 for CGST and
-- SGST, 0 for IGST. Both stay NULL on drafts, and on an order worth nothing confirmed before a state was known.
ALTER TABLE orders ADD COLUMN supply_state TEXT CHECK (supply_state IS NULL OR length(supply_state) = 2);
ALTER TABLE orders ADD COLUMN intra_state INTEGER CHECK (intra_state IS NULL OR intra_state IN (0, 1));
