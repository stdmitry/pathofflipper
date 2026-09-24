# Path of Flipper

Research tooling for finding Path of Exile 1 currency-flipping opportunities on the in-game currency exchange. Project specifications live in [`specs/`](./specs/README.md).

The current slice ([#9](https://github.com/stdmitry/pathofflipper/issues/9)) fetches hourly currency exchange history from the [official API](https://www.pathofexile.com/developer/docs/reference#currencyexchange) into a local PostgreSQL database. Fetching and parsing are separate stages ([#15](https://github.com/stdmitry/pathofflipper/issues/15)): `npm run fetch` stores raw responses, and `npm run parse` turns them into queryable rows.

**Only PoE 1 PC is supported.** Console realms (Xbox, PlayStation) are not collected ([#11](https://github.com/stdmitry/pathofflipper/issues/11)).

## Requirements

- Node.js 22.18 or newer (runs the TypeScript sources directly)
- Docker with Compose v2

## Setup

```sh
npm install
cp .env.example .env        # then set POSTGRES_PASSWORD and the same password in both URLs
npm run db:up               # starts PostgreSQL and waits until it is healthy
npm run db:migrate          # applies migrations/*.sql; safe to repeat
```

Upgrading from a version where fetch also parsed? Apply migration 0004 before the next fetch: `npm run db:migrate`.

Data lives in the `pgdata` Docker volume and survives `docker compose restart` and `npm run db:down`. Only `docker compose down -v` deletes it. The database listens on `127.0.0.1` only. `.env` holds the password and is excluded from git.

The first start of the volume also creates `pathofflipper_test` for the integration tests. If your volume predates that, create it once with `docker compose exec db createdb -U pathofflipper pathofflipper_test`.

## Fetching

```sh
npm run fetch                          # up to 24 hours, resuming from the stored cursor
npm run fetch -- --max-hours 3         # smaller batch
npm run fetch -- --help
npm run parse                          # parse every fetched hour not parsed yet into pair_hours
npm run metrics                        # recompute Chaos market metrics as of the newest parsed hour
npm run serve                          # read API on http://127.0.0.1:8080 (see Read API)
```

Fetch stores only raw responses, so run `npm run parse` and then `npm run metrics` afterwards, for example `npm run fetch; npm run parse; npm run metrics` in a schedule, with `npm run serve` running alongside. Use `;` rather than `&&` so that hours fetched before a failure still get parsed and counted.

Every run, manual or scheduled, fetches PoE 1 PC only. `--realm` and `POE_REALM` accept only `pc`; any other value, such as `xbox` or `sony`, exits with 2 before connecting to the database or the API.

Each run stores at most `--max-hours` completed hours (default 24, or `POE_MAX_HOURS`), then stops. It also stops early, with exit code 0, when it reaches the hour that hasn't been published yet. Failures exit with 1 and invalid options with 2.

**Bootstrap.** When no PC cursor is stored, the first request is for 24 completed hours ago. Override that once with `--start`:

- `--start 2026-09-20T00:00Z` (any ISO time with a zone, on the hour)
- `--start 1790143200` (unix seconds, on the hour)
- `--start earliest` (the start of retained history, July 2024; catching up from there takes over 18,000 requests)

After the first stored hour, `--start` is ignored and runs continue from the cursor.

**Resuming.** Every hour commits its raw response and the advanced cursor in one transaction. If a run is interrupted, whether by Ctrl+C, a crash or a database outage, the next run continues from the last committed PC hour. Cursors left by other realms in older databases are ignored and never changed. The first Ctrl+C finishes the current hour and exits; a second aborts immediately, and the uncommitted hour is rolled back. Only one fetch can run at a time.

**Failure handling.** Timeouts (30 s), network errors, HTTP 429 and 5xx are retried up to 5 attempts with exponential backoff, honoring `Retry-After` and the API's rate-limit headers. Fetch validates only what it needs to move the cursor: the body is a JSON object, `next_change_id` is an hour-aligned timestamp that doesn't go backwards, and `markets` is an array. A response that fails these checks is saved to `rejected_responses`, the cursor stays on that hour, and the run exits with 1. Market records are not validated at fetch time, so a record the parser rejects never stops collection. Requests identify the app through `User-Agent: pathofflipper/<version> (contact: $POE_USER_AGENT_CONTACT)`.

## Parsing

`npm run parse` handles every PC digest with `raw_digests.parser_version IS NULL`, oldest first, and stores each hour's markets in the dictionaries and `pair_hours` in one transaction, setting `parser_version`. It can be interrupted (Ctrl+C finishes the current hour) and rerun at any time. Replaying an hour inserts nothing new. Two parse runs never overlap, but parse can run while a fetch is running.

Validation requires every numeric value to be an integer within ±2^53, each numeric map to have exactly the pair's two items as keys, `market_id` to equal `item_a|item_b`, no duplicate league and market, and a pair never to appear in the reverse order of an already stored pair. When a digest fails, its problems go to `raw_digests.parse_error`, it stays pending, later hours are still parsed, and the run exits with 1. Every run retries pending digests, so a failing hour keeps being reported until the parser accepts it.

## Field semantics

`volume_traded` holds both sides of the same trades. The ratios are reduced `a:b` fractions giving the lowest and highest executed rate, and they are 0 when nothing traded. Stock is sampled unfilled-order quantity. Pair order is not a quote convention, so code reads markets through [`src/market/semantics.ts`](./src/market/semantics.ts) (`quoteHour`, `windowRate`, `classifyHour`) rather than through the `_a`/`_b` columns. The evidence, the metrics this supports and what remains open are in [API observations](./specs/exchange-api-observations.md#field-semantics).

`npm run check-semantics [-- --league <name>]` checks stored `pair_hours` against the invariants these rules rely on. It exits with 1 if any is violated. Run it when a new league starts.

## Metrics

`npm run metrics` computes activity metrics for every Chaos-quoted market over the last 1, 6 and 24 hours: coverage, turnover, traded units, persistence, a volume-weighted rate, the executed-rate range and volatility. It replaces the stored snapshot (`metric_runs`, `market_metrics`) in one transaction. `--as-of <hour>` recomputes an earlier hour. Eligible markets get an `activity_rank` by Chaos turnover. **The rank measures activity, not profitability.** Definitions, thresholds and the data behind them are in [Market metrics](./specs/market-metrics.md).

```sql
-- Top markets of a league over the last 24 hours
SELECT m.activity_rank, coalesce(i.display_name, i.metadata_path) AS item, round(m.rate_num::numeric / m.rate_den, 2) AS chaos_each,
       round(m.quote_per_hour) AS chaos_per_hour, m.traded_hours || '/' || m.covered_hours AS traded_of_covered,
       round(m.volatility::numeric, 3) AS volatility, r.as_of_hour
FROM market_metrics m
JOIN metric_runs r ON r.id = m.run_id
JOIN leagues l ON l.id = m.league_id
JOIN pairs p ON p.id = m.pair_id
JOIN items i ON i.id = CASE WHEN p.item_a_id = r.quote_item_id THEN p.item_b_id ELSE p.item_a_id END
WHERE l.name = 'Mirage' AND m.window_hours = 24 AND m.activity_rank IS NOT NULL
ORDER BY m.activity_rank LIMIT 20;
```

## Read API

`npm run serve` serves stored data over HTTP (`--port`/`API_PORT`, default 8080; `--host`/`API_HOST`, default `127.0.0.1`). It only reads PostgreSQL and never calls the exchange, so traffic to it cannot reach upstream. All endpoints are `GET` (or `HEAD`), take `realm=pc` optionally, and answer JSON as `{ "data": ..., "meta": ... }`.

| Endpoint | Returns |
|---|---|
| `GET /api/leagues` | Public leagues in the current metrics snapshot: `active` (present in the newest hour), market and eligible-market counts for 24h. Private leagues (`… (PL<number>)`) are stored but never served; asking for one answers 404. |
| `GET /api/markets?league=<name>` | Chaos markets of a league with their metrics. `window=1h\|6h\|24h` (24h), `scope=eligible\|all` (eligible), `sort=rank\|turnover\|units\|persistence\|volatility\|rate\|name` (rank), `order=asc\|desc`, `q=<text>` (name or path), `limit` 1–100 (50), `offset` 0–10,000. `meta.total` counts all matches. |
| `GET /api/markets/<id>/history?league=<name>` | One point per hour, ending at the newest parsed hour, plus a summary over the window. `window=24h\|7d\|30d` (24h). Every hour has a `status`: `missing`, `exchange-down`, `league-absent` (all three unknown), `inactive`, `listed` or `traded`. Gaps are never left out or zero-filled. |
| `GET /api/status` | `state` (`ok` or `degraded`) with the `problems` behind it: `no_data`, `stale_source`, `last_fetch_failed`, `parse_failures`, `rejected_responses`, `metrics_behind`, `gaps_last_24h`. Also cursor, newest fetched and parsed hours, pending and failed parses, and the metrics snapshot. |

- **Market ids** in paths are opaque. Take them from `/api/markets`; they stay the same across database rebuilds.
- **Units** are listed in `meta.units`. Rates are `{num, den, value}`: exact fraction strings plus a decimal for display. Integer totals are strings, so they stay exact beyond 2^53.
- **Freshness**: every response carries `as_of_hour`, `source_age_hours` and `stale` (older than 3 hours). Stale data is still served, so clients can keep showing it with its age during an outage. Market responses also carry `calc_version`, `computed_at` and the reminder that the ranking measures activity, not profitability.
- **Errors** are `{ "error": { "code", "message" } }`: `400 invalid_parameter` (with `parameter`; unknown, repeated or out-of-range parameters are all rejected), `404 not_found`, `405` for other methods, `503 unavailable` when the database is down, and `500 internal`.
- **Caching**: responses other than `/api/status` are cached in memory under a version that changes when a parse or metrics run commits, so new data shows up on the next request. They carry an `ETag` and answer `If-None-Match` with `304`.

## Storage

Each hour is stored twice: `raw_digests` keeps the response verbatim (permanently, as the only lossless copy), and `pair_hours` holds its values as integers.

- `leagues`, `items` and `pairs` are dictionaries with integer ids. A pair is two items in upstream `market_pair` order, shared by all leagues. Order `a`/`b` doesn't imply a buy or sell side.
- `pair_hours` has one row per league, pair and hour, with `volume_traded`, `lowest_stock`, `highest_stock`, `lowest_ratio` and `highest_ratio` for each side as `bigint` (`volume_traded_a`, `volume_traded_b`, …). The primary key `(league_id, pair_id, source_hour)` makes one pair's history in a league fast. A BRIN index on `source_hour` (about 100 kB) lets reads of recent hours across all pairs skip older rows.
- `league_hours` counts each league's markets per parsed hour. Parse fills it, and it tells a market that is inactive in a running league from a league that isn't running.
- Markets with zero traded volume are kept: they show listings existed without trades. An hour with no `raw_digests` row is unknown, not inactive. A fetched hour has no `pair_hours` rows until it is parsed, so check `raw_digests.parser_version` before reading a missing hour as empty.
- `items.display_name` comes from [`data/item-names.json`](./data/item-names.json), a trimmed snapshot of RePoE's [`base_items.json`](https://repoe-fork.github.io/base_items.json). New items are named when first stored. Paths missing from the snapshot keep `display_name` NULL; show the path instead. Names are not unique (two items are called "Delirium Orb"). Refresh once per league with `npm run item-names -- --download`, review the diff, and commit it.

### Upgrading a database from the jsonb `market_hours` table ([#13](https://github.com/stdmitry/pathofflipper/issues/13))

```sh
# stop any running fetch first
npm run db:migrate   # applies 0002, then 0003 refuses to drop market_hours: "N stored hours are not fully rebuilt"
npm run rebuild      # re-parses every raw digest into pair_hours; resumable, compares with market_hours
npm run db:migrate   # 0003 now drops market_hours, then 0004 applies
```

Fetching and parsing can resume once 0004 is applied. `rebuild` marks the digests it parses, so `parse` doesn't redo them, and `rebuild` skips hours that are already complete. `rebuild` exits with 1 if a stored digest fails validation or any `market_hours` row differs from `pair_hours`; 0003 stays blocked until every digest's market count matches its `pair_hours` rows. Dropping the table frees its disk space immediately. Payloads stored before 0002 stay `pglz`-compressed; new ones use `lz4`.

## Inspecting data

Open a shell with `npm run db:psql`, then for example:

```sql
-- Collection progress (only the pc row is used; older non-PC rows are kept but ignored)
SELECT realm, to_timestamp(next_cursor) AS next_hour, last_success_at, last_error, last_error_at
FROM ingestion_cursors;

-- Stored hours and whether they are parsed (parser_version NULL = pending)
SELECT source_hour, market_count, first_fetched_at, parser_version, checksum FROM raw_digests ORDER BY source_hour DESC LIMIT 10;

-- Fetched hours the parser rejected
SELECT source_hour, parse_error FROM raw_digests WHERE parse_error IS NOT NULL ORDER BY source_hour;

-- Markets per league in the latest parsed hour
SELECT l.name, count(*) FROM pair_hours h JOIN leagues l ON l.id = h.league_id
WHERE h.source_hour = (SELECT max(source_hour) FROM raw_digests WHERE parser_version IS NOT NULL)
GROUP BY l.name ORDER BY 2 DESC;

-- One pair's history in a league (uses the primary key)
SELECT h.source_hour, h.volume_traded_a, h.volume_traded_b, h.lowest_ratio_a, h.lowest_ratio_b, h.highest_ratio_a, h.highest_ratio_b
FROM pair_hours h
JOIN leagues l ON l.id = h.league_id
JOIN pairs p ON p.id = h.pair_id
JOIN items a ON a.id = p.item_a_id
JOIN items b ON b.id = p.item_b_id
WHERE l.realm = 'pc' AND l.name = 'Mercenaries'
  AND a.metadata_path = 'Metadata/Items/Currency/CurrencyRerollRare'
  AND b.metadata_path = 'Metadata/Items/Currency/CurrencyModValues'
ORDER BY h.source_hour DESC LIMIT 24;

-- Pairs with readable names
SELECT p.id, coalesce(a.display_name, a.metadata_path) AS item_a, coalesce(b.display_name, b.metadata_path) AS item_b
FROM pairs p JOIN items a ON a.id = p.item_a_id JOIN items b ON b.id = p.item_b_id LIMIT 20;

-- Responses fetch rejected (envelope problems)
SELECT id, to_timestamp(request_cursor) AS hour, problems, fetched_at FROM rejected_responses;
```

`source_hour` is the hour the data describes; the matching `raw_digests` row says when we fetched it. What the fields mean is described under [Field semantics](./specs/exchange-api-observations.md#field-semantics).

## Tests

```sh
npm test            # unit tests, plus PostgreSQL integration tests when TEST_DATABASE_URL is set
npm run typecheck
```

Integration tests need the database running (`npm run db:up`). They migrate and truncate the `pathofflipper_test` database, never the main one. Without `TEST_DATABASE_URL` they are reported as skipped.
