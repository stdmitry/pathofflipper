-- Calculation version 5 checks whether a 1h opportunity held in the previous hours (see heldCheck). Filled for the
-- 1h window only; NULL for longer windows.
ALTER TABLE market_metrics
  ADD COLUMN held_hours smallint,
  ADD COLUMN checked_hours smallint,
  ADD COLUMN price_drift double precision,
  ADD COLUMN moving boolean;
