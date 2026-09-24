-- Currency exchange gold fees. An order costs the wanted item's fee per unit wanted; the offered item does not
-- matter. Filled from data/gold-fees.json by npm run gold-fees; NULL when the game data has no fee for the item.
ALTER TABLE items ADD COLUMN gold_fee integer CHECK (gold_fee >= 0);

-- Calculation version 3 adds the gold needed to buy one unit at the window's low and sell it at its high, and the
-- quote earned per 1,000 gold on that round trip. NULL when a fee or a price is unknown.
ALTER TABLE market_metrics
  ADD COLUMN gold_per_flip double precision,
  ADD COLUMN quote_per_kgold double precision;
