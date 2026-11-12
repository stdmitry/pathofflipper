# Scheduled pipeline: run fetch, parse, metrics and derived calculations in order

Status: implemented (issue #29).

## Problem

Every stage is a separate CLI run by hand or by a cron line such as `npm run fetch; npm run parse; npm run metrics` (README). This has four problems:

- **No dependencies.** Cron does not know that metrics need parsed hours, or that the Runegraft price needs the Chaos metrics snapshot. A fixed time offset can run a stage on old data, and a chain joined with `;` runs every stage even when nothing new arrived.
- **No stored result for Runegraft.** The recommended Runegraft buy price is computed on every `npm run runegraft` call and every `/api/opportunities` request. It has no history, and it can't be shown in a status view or compared over time.
- **No place for new jobs.** The audits (`specs/currency-arbitrage-audit-report.md` E-1…E-5, `specs/poe_market_making_audit.md`) add more derived calculations, such as effective price tables, closed triangles and market-making quotes. Each would need its own cron line and its own guess about timing.
- **No visibility.** Only fetch records its last error (`ingestion_cursors`). Nothing records whether parse, metrics or Runegraft last ran, how long they took or why they failed. Issue #8 asks for this.

## Goal

One scheduler runs a fixed graph of jobs. A job runs only when its input has new data and only after the jobs it depends on. Every run is recorded. Adding a job means writing one module and declaring what it depends on.

Out of scope: distributed workers, a job queue service, retry back-off per job beyond what is described here, and running jobs from the dashboard.

## Jobs

| Job | Depends on | Input watermark | Output watermark | Status |
|---|---|---|---|---|
| `fetch` | (clock) | — | newest stored `raw_digests.source_hour` | exists (`ingest`) |
| `parse` | `fetch` | newest stored hour | newest parsed hour | exists (`parsePending`) |
| `metrics` | `parse` | newest parsed hour | `metric_runs.as_of_hour` (Chaos and Divine) | exists (`computeMetrics`) |
| `runegraft` | `metrics` | Chaos `as_of_hour` | `runegraft_runs.as_of_hour` | **new**: stores EV and recommended price |
| `check-semantics` | `parse` | daily | — | exists; run once a day, report only |
| `effective-prices`, `triangles`, … | `metrics` | Chaos and Divine `as_of_hour` | own table | future (audit E-1…E-5) |
| `market-making` | `metrics` | — | — | future, blocked on #7 |

`gold-fees --download` and `item-names --download` are **not** scheduled. Their output is a file whose diff a person reviews and commits.

### Dependencies follow data, not exit codes

A job runs when its input watermark differs from the input of its last successful run (watermarks are opaque strings compared for equality). A job whose last run failed, timed out, was busy or was interrupted runs again in the next tick even on the same input. Whether the upstream job succeeded in this tick does not matter. This keeps today's `;` behavior: if fetch fails after storing 5 hours, parse still parses them, and metrics still computes on them.

A job is skipped (status `up-to-date`) when its input has not moved. A job whose input is missing (for example, no metrics snapshot yet) is skipped with status `waiting`, and a job whose `due` rule says no (check-semantics after its daily run) with `not-due`. A job that ran but found nothing new (fetch caught up with no new hour, parse with nothing pending) is `idle`: its state is updated, but no `job_runs` row is written.

Watermarks in use: parse reads the newest stored hour; metrics the newest parsed hour plus the calculation version (a new version recomputes the same hour); runegraft the Chaos snapshot hour, its `metric_runs.id` (a recompute of the same hour, e.g. after new gold fees) and the weights file hash.

### Runegraft job (new)

The job computes and stores what `npm run runegraft` prints, with the default margin and minimum outcome price, for every public league with at least one Runegraft Chaos market in the Chaos snapshot, and for windows 1h and 24h (window/league pairs with no priced Runegraft are left out). It uses the same functions: `runegraftPrices`, `expectedValue`, `breakEvenBuyPrice`, `recommendedBuyPrice` and `findOpportunities`.

New migration:

```sql
CREATE TABLE runegraft_runs (
  id            bigserial PRIMARY KEY,
  realm         text NOT NULL,
  league_id     integer NOT NULL REFERENCES leagues(id),
  window_hours  smallint NOT NULL,
  as_of_hour    timestamptz NOT NULL,          -- Chaos metrics snapshot it was computed from
  metric_run_id bigint NOT NULL,               -- the metric_runs row; no FK, snapshots are replaced
  weights_sha256 text NOT NULL,                -- data/runegraft-weights.json it used
  margin        double precision NOT NULL,
  min_outcome_price double precision NOT NULL,
  ev            double precision,              -- NULL when no outcome is priced
  ev_is_estimate boolean NOT NULL,             -- unknown probabilities or prices
  break_even    double precision,
  recommended   double precision,
  priced_outcomes smallint NOT NULL,
  unknown_outcomes smallint NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, league_id, window_hours, as_of_hour)
);

CREATE TABLE runegraft_run_items (
  run_id        bigint NOT NULL REFERENCES runegraft_runs(id) ON DELETE CASCADE,
  item_id       integer NOT NULL REFERENCES items(id),
  buy_price     double precision NOT NULL,     -- lowest executed Chaos price in the window
  sell_price    double precision NOT NULL,     -- volume-weighted Chaos price
  below_recommended boolean,                   -- NULL when EV is unknown
  expected_profit double precision,            -- EV − 3 × buy_price; NULL when EV is unknown
  PRIMARY KEY (run_id, item_id)
);
```

Unlike `market_metrics`, runs are **kept**: one row per league, window and hour, so the recommended price has a history. Rerunning the same hour replaces that hour's runs (delete the hour's rows and insert, in one transaction).

Follow-up, not in this issue: the `runegraft` provider of `/api/opportunities` and `npm run runegraft` read the stored run when its `as_of_hour` matches the Chaos snapshot, and compute live otherwise (for example, with non-default `--margin`).

## Scheduler

### Commands

- `npm run pipeline` runs **one tick**: every due job in dependency order, then exits. Exit 0 when no job failed, 1 when some job failed, 2 on invalid configuration. This is the command for cron, launchd or a systemd timer.
- `npm run scheduler` is a long-running process that runs a tick on a timer (below). This is the command for `compose.yaml` or a terminal. It uses the same tick function.
- Both take `--only <job>[,<job>]` (run these and nothing downstream), `--force` (run even when not due or the input has not changed), `--max-hours` and `--pause-ms`. `npm run pipeline` also takes `--dry-run` (print which jobs are due and why, record nothing).

### Timing

The exchange publishes an hour right after it ends. 08:00–09:00 was served at 09:00:01 (`specs/exchange-api-observations.md`). The scheduler:

1. Ticks at **hh:01**.
2. If fetch returned `caught-up` without a new hour, it retries every **5 minutes** until hh:30, then waits for the next hour.
3. If fetch stopped at `--max-hours` (`limit`, a backlog after downtime), the next tick starts **immediately**, so a backlog drains at the fetch pause rate. Downstream jobs run once per batch of `--max-hours` hours, not once per hour.
4. `check-semantics` runs in the first tick after 00:00 UTC.

Metrics are computed only for the newest parsed hour, as now. A backlog does not backfill metrics or Runegraft runs for the hours in between. `npm run metrics -- --as-of` remains the way to do that by hand.

### One tick

```
acquire pipeline lock (pg_try_advisory_lock, namespace 7_319_010; the Runegraft job has its own, 7_319_011) — held: log "tick already running", exit 0
for job in topological order:
  input = job.inputWatermark(pool)
  last  = job_state[job].input_watermark
  if input is null            → record 'waiting', continue
  if input <= last && !forced → record 'up-to-date', continue
  run job.run(ctx) with timeout → record 'ok' | 'failed' (+ error), update job_state on ok
release lock
```

The existing per-stage locks (`withIngestLock`, `withParseLock`, `withMetricsLock`) stay. A manual `npm run fetch` during a tick fails with `ConcurrentRunError`, and the tick records that job as `busy`, not `failed`.

A job failure never stops the tick. Later jobs check their own inputs.

### Job interface

```ts
// src/pipeline/job.ts. Jobs get the pool and the exchange client from createJobs(pool, config), not from the context.
export interface JobContext { logger: Logger; now: Date; shouldStop: () => boolean }

export interface Job {
  name: string;
  dependsOn: readonly string[];
  /** When to consider the job at all; default: every tick. */
  due?: (now: Date, state: JobState | null) => boolean;
  /** Newest input this job would read, compared for equality; null = no input yet. Without it the job runs whenever due. */
  inputWatermark?: () => Promise<string | null>;
  /** idle: ran, nothing new; interrupted: stopped by shouldStop; problem: finished but failed (e.g. invalid hours). */
  run(ctx: JobContext): Promise<{ outputWatermark: string | null; details: Record<string, unknown>; idle?: boolean; interrupted?: boolean; problem?: string }>;
  timeoutMs: number;
}
```

`src/pipeline/jobs.ts` lists the jobs, `src/pipeline/runner.ts` runs a tick against a `StateStore` (PostgreSQL, or memory in unit tests), and `src/pipeline/schedule.ts` computes the delay to the next tick. Each wraps the existing function (`ingest`, `parsePending`, `computeMetrics` per quote, `computeRunegraft`). CLI files keep working and stay thin. The registry is checked at startup for unknown and cyclic dependencies.

### State and history

```sql
CREATE TABLE job_state (
  job              text PRIMARY KEY,
  last_status      text NOT NULL,  -- ok, idle, failed, busy, timeout, interrupted
  last_run_at      timestamptz NOT NULL,
  input_watermark  text,          -- input the last successful run finished on
  output_watermark text,
  last_success_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE TABLE job_runs (
  id          bigserial PRIMARY KEY,
  tick_id     uuid NOT NULL,
  job         text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ok','failed','busy','timeout','interrupted')),
  input_watermark  text,
  output_watermark text,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  details     jsonb,              -- the job's summary, e.g. hours_stored, rows, eligible
  error       text
);
CREATE INDEX ON job_runs (job, started_at DESC);
```

Only runs that did something (`ok`, `failed`, `busy`, `timeout`, `interrupted`) go into `job_runs`. Skips update nothing and idle runs update only `job_state`, so an idle hour of retries adds no rows. Runs older than 30 days are deleted by the tick.

### Shutdown and failure

- SIGINT/SIGTERM: the current job finishes its current hour (existing `shouldStop`), and the tick records `interrupted` and exits. A second signal exits immediately, as now.
- A timeout cannot kill a running query: it turns `shouldStop` on, so fetch and parse end after their current hour, and the run is recorded as `timeout` when the job returns. Defaults are fetch 30 min, parse 30 min, metrics 10 min, runegraft 2 min.
- Every failure logs at ERROR. After 3 consecutive failures (`failed` or `timeout`; `busy` does not count), `/api/status` marks the job `failing` and adds the `jobs_failing` problem. No other alerting is in this issue.

### Status

`GET /api/status` gains `jobs: [{ job, last_status, last_run_at, last_success_at, input_watermark, output_watermark, consecutive_failures, failing, last_error, last_error_at }]`, read from `job_state`. The dashboard's existing status line can show the oldest failing job. This covers the "monitor lag, retries" part of #8.

## Deployment

- `compose.yaml` gets an optional `scheduler` service (`node src/cli/scheduler.ts`, `restart: unless-stopped`, `depends_on: db: condition: service_healthy`), behind a profile so `npm run db:up` still starts only PostgreSQL.
- README replaces the `fetch; parse; metrics` cron advice with `npm run scheduler`, or `npm run pipeline` from cron every 5 minutes (the lock and watermarks make extra calls cheap no-ops).

## Tests

- Unit (`test/pipeline.test.ts`), with fake jobs and an in-memory state store:
  - topological order; a cycle or an unknown dependency is rejected
  - a job is skipped when its input has not moved, and runs when it has
  - a failed upstream job does not block a downstream job whose input moved
  - `--only` runs the named jobs only
  - timing: retries after `caught-up`, an immediate next tick after `limit`, daily `check-semantics`
- Integration (`test/pipeline.integration.test.ts`), with a fixture `ExchangeSource`:
  - two ticks over 3 fixture hours give the same `pair_hours`, `market_metrics` and `runegraft_runs` as running the CLIs in order
  - a second tick with no new hour writes no `job_runs` rows
  - a concurrent tick exits 0 without running jobs
  - a manual fetch holding the ingest lock gives `busy`
  - the Runegraft run matches `npm run runegraft` output for the same snapshot, and rerunning an hour replaces its run

## Acceptance criteria

- [ ] `npm run pipeline` and `npm run scheduler` run fetch → parse → metrics → runegraft by data watermarks
- [ ] Runegraft EV, break-even and recommended price are stored per league, window and hour, with history kept
- [ ] `job_state` and `job_runs` record every non-skipped run; `/api/status` shows per-job state
- [ ] Idle ticks are no-ops; overlapping ticks never run a job twice
- [ ] Adding a job takes one module and one registry entry, with no change to the runner
- [ ] Existing CLIs, `/api/*` responses and tests unchanged
- [ ] README and `compose.yaml` updated

## Open questions

1. Should Runegraft runs use only the default margin and min price, or a small set of margins? The proposal is defaults only, with others computed live.
2. Should a metrics backlog after downtime be backfilled automatically, which costs one metrics run per hour? The proposal is no.
3. Should old `runegraft_runs` be kept forever? At about 2 leagues × 2 windows × 24 hours a day, that is about 35k rows a year, so the proposal is to keep them.
