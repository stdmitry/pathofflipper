-- Market activity metrics (issue #4). Definitions: specs/market-metrics.md.

-- The third segment of the Metadata path groups the catalog: Currency, DivinationCards, Scarabs, MapFragments, ...
ALTER TABLE items ADD COLUMN category text GENERATED ALWAYS AS (split_part(metadata_path, '/', 3)) STORED;

-- Metrics read recent hours across all pairs. pair_hours is appended roughly in hour order, so a BRIN index stays
-- tiny and still skips old blocks. autosummarize covers ranges filled after creation, which would otherwise always
-- be scanned.
CREATE INDEX pair_hours_source_hour_brin ON pair_hours USING brin (source_hour) WITH (autosummarize = on);

-- One computation of every market's metrics as of a completed source hour. Only the latest run per realm, quote item
-- and calculation version is kept: runs are reproducible from pair_hours.
CREATE TABLE metric_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm text NOT NULL,
  -- Prices read as quote units per one unit of the pair's other item.
  quote_item_id integer NOT NULL REFERENCES items (id),
  calc_version integer NOT NULL,
  -- Newest source hour in every window; windows end with it.
  as_of_hour timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, quote_item_id, calc_version)
);

-- One row per league, quote pair and window. Rates are exact reduced fractions (quote per base); per-hour values divide
-- by covered hours, so missing hours never count as inactivity.
CREATE TABLE market_metrics (
  run_id bigint NOT NULL REFERENCES metric_runs (id) ON DELETE CASCADE,
  league_id integer NOT NULL REFERENCES leagues (id),
  pair_id integer NOT NULL REFERENCES pairs (id),
  window_hours smallint NOT NULL CHECK (window_hours IN (1, 6, 24)),
  covered_hours smallint NOT NULL,
  traded_hours smallint NOT NULL,
  base_volume bigint NOT NULL,
  quote_volume bigint NOT NULL,
  rate_num bigint,
  rate_den bigint,
  low_rate_num bigint,
  low_rate_den bigint,
  high_rate_num bigint,
  high_rate_den bigint,
  volatility double precision,
  -- Position among eligible markets of the league and window by quote turnover; NULL when not eligible.
  activity_rank integer,
  quote_per_hour numeric GENERATED ALWAYS AS (quote_volume::numeric / nullif(covered_hours, 0)) STORED,
  base_per_hour numeric GENERATED ALWAYS AS (base_volume::numeric / nullif(covered_hours, 0)) STORED,
  PRIMARY KEY (run_id, league_id, window_hours, pair_id),
  CHECK (0 <= traded_hours AND traded_hours <= covered_hours AND covered_hours <= window_hours),
  CHECK ((rate_num IS NULL) = (traded_hours = 0)),
  CHECK (activity_rank IS NULL OR traded_hours > 0)
);
