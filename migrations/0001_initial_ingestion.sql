-- Storage for the currency exchange collector (issue #9).
-- Cursors and source hours are unix timestamps aligned to the hour, as used by the exchange API.
-- Original numeric fields stay in jsonb, which stores numbers as exact numeric values.

CREATE TABLE ingestion_cursors (
  realm text PRIMARY KEY CHECK (realm IN ('pc', 'xbox', 'sony')),
  -- Cursor to request next; NULL until the first hour is committed.
  next_cursor bigint CHECK (next_cursor >= 0 AND next_cursor % 3600 = 0),
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_digests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm text NOT NULL CHECK (realm IN ('pc', 'xbox', 'sony')),
  -- NULL when requested without a cursor (the earliest available history).
  request_cursor bigint,
  next_cursor bigint NOT NULL,
  source_hour timestamptz NOT NULL,
  http_status smallint NOT NULL,
  market_count integer NOT NULL,
  -- sha256 of the response body bytes.
  checksum text NOT NULL,
  parser_version integer NOT NULL,
  payload jsonb NOT NULL,
  first_fetched_at timestamptz NOT NULL,
  last_fetched_at timestamptz NOT NULL,
  UNIQUE (realm, source_hour, checksum)
);

CREATE TABLE market_hours (
  realm text NOT NULL CHECK (realm IN ('pc', 'xbox', 'sony')),
  league text NOT NULL,
  source_hour timestamptz NOT NULL,
  market_id text NOT NULL,
  -- market_pair[0] and market_pair[1], in upstream order. No buy/sell meaning is implied.
  item_a_id text NOT NULL,
  item_b_id text NOT NULL,
  volume_traded jsonb NOT NULL,
  lowest_stock jsonb NOT NULL,
  highest_stock jsonb NOT NULL,
  lowest_ratio jsonb NOT NULL,
  highest_ratio jsonb NOT NULL,
  raw_digest_id bigint NOT NULL REFERENCES raw_digests (id),
  -- When we fetched the data, as opposed to source_hour, the hour the data describes.
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (realm, league, source_hour, market_id)
);

CREATE INDEX market_hours_raw_digest_id_idx ON market_hours (raw_digest_id);

-- Responses that failed validation, kept verbatim for diagnosis. The cursor never advances past them.
CREATE TABLE rejected_responses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm text NOT NULL,
  request_cursor bigint,
  http_status smallint NOT NULL,
  checksum text NOT NULL,
  problems jsonb NOT NULL,
  body text NOT NULL,
  fetched_at timestamptz NOT NULL
);
