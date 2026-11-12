-- Scheduled pipeline (issue #29, specs/scheduled-pipeline-spec.md): per-job state, run history and stored Runegraft runs.

-- One row per job. Watermarks are opaque strings compared for equality: a job runs again when its input changes.
CREATE TABLE job_state (
  job text PRIMARY KEY,
  last_status text NOT NULL,
  last_run_at timestamptz NOT NULL,
  -- Input and output of the last successful run; a failed run leaves them alone so the next tick retries.
  input_watermark text,
  output_watermark text,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
);

-- Runs that did something. Skipped and idle runs are not recorded, so ticks that find nothing new add no rows.
CREATE TABLE job_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tick_id uuid NOT NULL,
  job text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'failed', 'busy', 'timeout', 'interrupted')),
  input_watermark text,
  output_watermark text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  details jsonb,
  error text
);
CREATE INDEX job_runs_job_started_at ON job_runs (job, started_at DESC);

-- Runegraft 3:1 conversion EV and recommended buy price per league and window, from the current Chaos metrics snapshot.
-- Like market_metrics, only the latest computation is kept: every run replaces all rows.
CREATE TABLE runegraft_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  realm text NOT NULL,
  league_id integer NOT NULL REFERENCES leagues (id),
  window_hours smallint NOT NULL,
  -- The Chaos metrics snapshot the prices came from. No foreign key: snapshots are replaced.
  as_of_hour timestamptz NOT NULL,
  metric_run_id bigint NOT NULL,
  weights_sha256 text NOT NULL,
  margin double precision NOT NULL,
  min_outcome_price double precision NOT NULL,
  -- NULL when no outcome priced above the minimum has a probability.
  ev double precision,
  ev_is_estimate boolean NOT NULL,
  break_even double precision,
  recommended double precision,
  priced_outcomes smallint NOT NULL,
  unknown_outcomes smallint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, league_id, window_hours)
);

CREATE TABLE runegraft_run_items (
  run_id bigint NOT NULL REFERENCES runegraft_runs (id) ON DELETE CASCADE,
  item_id integer NOT NULL REFERENCES items (id),
  -- Lowest executed Chaos price in the window.
  buy_price double precision NOT NULL,
  -- Volume-weighted Chaos price in the window.
  sell_price double precision NOT NULL,
  below_recommended boolean,
  -- EV − 3 × buy_price; NULL when EV is unknown.
  expected_profit double precision,
  PRIMARY KEY (run_id, item_id)
);
