-- Compact market history (issue #13): item, pair and league dictionaries plus integer hourly values.
-- market_hours stays until `npm run rebuild` has re-parsed every stored digest; 0003 then drops it.

-- New payloads only; existing rows keep pglz until they are rewritten.
ALTER TABLE raw_digests ALTER COLUMN payload SET COMPRESSION lz4;

-- Published hours are immutable, so one digest per hour; pair_hours reaches its digest through source_hour.
ALTER TABLE raw_digests
  DROP CONSTRAINT raw_digests_realm_source_hour_checksum_key,
  ADD CONSTRAINT raw_digests_realm_source_hour_key UNIQUE (realm, source_hour);

CREATE TABLE leagues (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm text NOT NULL CHECK (realm IN ('pc', 'xbox', 'sony')),
  name text NOT NULL,
  UNIQUE (realm, name)
);

CREATE TABLE items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Upstream item id, e.g. Metadata/Items/Currency/CurrencyRerollRare.
  metadata_path text NOT NULL UNIQUE,
  -- From the vendored RePoE snapshot (data/item-names.json); NULL when the path is unknown. Not unique.
  display_name text
);

-- item_a/item_b follow the upstream market_pair order. No buy/sell meaning is implied.
CREATE TABLE pairs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_a_id integer NOT NULL REFERENCES items (id),
  item_b_id integer NOT NULL REFERENCES items (id),
  CHECK (item_a_id <> item_b_id),
  UNIQUE (item_a_id, item_b_id)
);

-- Two items form at most one pair, so a market_pair seen in the reverse order is rejected instead of stored twice.
CREATE UNIQUE INDEX pairs_unordered_key ON pairs (least(item_a_id, item_b_id), greatest(item_a_id, item_b_id));

-- One row per league, pair and hour. Columns ending in _a/_b hold the upstream value keyed by item_a/item_b.
CREATE TABLE pair_hours (
  league_id integer NOT NULL REFERENCES leagues (id),
  pair_id integer NOT NULL REFERENCES pairs (id),
  source_hour timestamptz NOT NULL,
  volume_traded_a bigint NOT NULL,
  volume_traded_b bigint NOT NULL,
  lowest_stock_a bigint NOT NULL,
  lowest_stock_b bigint NOT NULL,
  highest_stock_a bigint NOT NULL,
  highest_stock_b bigint NOT NULL,
  lowest_ratio_a bigint NOT NULL,
  lowest_ratio_b bigint NOT NULL,
  highest_ratio_a bigint NOT NULL,
  highest_ratio_b bigint NOT NULL,
  PRIMARY KEY (league_id, pair_id, source_hour)
);
