# Path of Flipper

Research tooling for finding Path of Exile 1 currency-flipping opportunities on the in-game currency exchange. Project specifications live in [`specs/`](./specs/README.md).

The current slice ([#9](https://github.com/stdmitry/pathofflipper/issues/9)) fetches hourly currency exchange history from the [official API](https://www.pathofexile.com/developer/docs/reference#currencyexchange) into a local PostgreSQL database.

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

Data lives in the `pgdata` Docker volume and survives `docker compose restart` and `npm run db:down`. Only `docker compose down -v` deletes it. The database listens on `127.0.0.1` only. `.env` holds the password and is excluded from git.

The first start of the volume also creates `pathofflipper_test` for the integration tests. If your volume predates that, create it once with `docker compose exec db createdb -U pathofflipper pathofflipper_test`.

## Fetching

```sh
npm run fetch                          # up to 24 hours, resuming from the stored cursor
npm run fetch -- --max-hours 3         # smaller batch
npm run fetch -- --help
```

Every run, manual or scheduled, fetches PoE 1 PC only. `--realm` and `POE_REALM` accept only `pc`; any other value, such as `xbox` or `sony`, exits with 2 before connecting to the database or the API.

Each run stores at most `--max-hours` completed hours (default 24, or `POE_MAX_HOURS`), then stops. It also stops early, with exit code 0, when it reaches the hour that hasn't been published yet. Failures exit with 1 and invalid options with 2.

**Bootstrap.** When no PC cursor is stored, the first request is for 24 completed hours ago. Override that once with `--start`:

- `--start 2026-09-20T00:00Z` (any ISO time with a zone, on the hour)
- `--start 1790143200` (unix seconds, on the hour)
- `--start earliest` (the start of retained history, July 2024; catching up from there takes over 18,000 requests)

After the first stored hour, `--start` is ignored and runs continue from the cursor.

**Resuming.** Every hour commits its raw response, market rows and the advanced cursor in one transaction. If a run is interrupted, whether by Ctrl+C, a crash or a database outage, the next run continues from the last committed PC hour. Cursors left by other realms in older databases are ignored and never changed. The first Ctrl+C finishes the current hour and exits; a second aborts immediately, and the uncommitted hour is rolled back. Only one fetch or rebuild can run at a time.

**Failure handling.** Timeouts (30 s), network errors, HTTP 429 and 5xx are retried up to 5 attempts with exponential backoff, honoring `Retry-After` and the API's rate-limit headers. A response that fails validation is saved to `rejected_responses`, the cursor stays on that hour, and the run exits with 1. Validation requires every numeric value to be an integer within ±2^53, `market_id` to equal `item_a|item_b`, and a pair never to appear in the reverse order of an already stored pair. Requests identify the app through `User-Agent: pathofflipper/<version> (contact: $POE_USER_AGENT_CONTACT)`.

## Storage

Each hour is stored twice: `raw_digests` keeps the response verbatim (permanently, as the only lossless copy), and `pair_hours` holds its values as integers.

- `leagues`, `items` and `pairs` are dictionaries with integer ids. A pair is two items in upstream `market_pair` order, shared by all leagues. Order `a`/`b` doesn't imply a buy or sell side.
- `pair_hours` has one row per league, pair and hour, with `volume_traded`, `lowest_stock`, `highest_stock`, `lowest_ratio` and `highest_ratio` for each side as `bigint` (`volume_traded_a`, `volume_traded_b`, …). Its only index is the primary key `(league_id, pair_id, source_hour)`, so reading one pair's history in a league is fast; whole-league scans are not indexed yet.
- Markets with zero traded volume are kept: they show listings existed without trades. An hour with no `raw_digests` row is unknown, not inactive.
- `items.display_name` comes from [`data/item-names.json`](./data/item-names.json), a trimmed snapshot of RePoE's [`base_items.json`](https://repoe-fork.github.io/base_items.json). New items are named when first stored. Paths missing from the snapshot keep `display_name` NULL; show the path instead. Names are not unique (two items are called "Delirium Orb"). Refresh once per league with `npm run item-names -- --download`, review the diff, and commit it.

### Upgrading a database from the jsonb `market_hours` table ([#13](https://github.com/stdmitry/pathofflipper/issues/13))

```sh
# stop any running fetch first
npm run db:migrate   # applies 0002, then 0003 refuses to drop market_hours: "N stored hours are not fully rebuilt"
npm run rebuild      # re-parses every raw digest into pair_hours; resumable, compares with market_hours
npm run db:migrate   # 0003 now drops market_hours
```

Fetching can resume once 0002 is applied; it writes only the new tables, and `rebuild` skips hours that are already complete. `rebuild` exits with 1 if a stored digest fails validation or any `market_hours` row differs from `pair_hours`; 0003 stays blocked until every digest's market count matches its `pair_hours` rows. Dropping the table frees its disk space immediately. Payloads stored before 0002 stay `pglz`-compressed; new ones use `lz4`.

## Inspecting data

Open a shell with `npm run db:psql`, then for example:

```sql
-- Collection progress (only the pc row is used; older non-PC rows are kept but ignored)
SELECT realm, to_timestamp(next_cursor) AS next_hour, last_success_at, last_error, last_error_at
FROM ingestion_cursors;

-- Stored hours
SELECT source_hour, market_count, first_fetched_at, checksum FROM raw_digests ORDER BY source_hour DESC LIMIT 10;

-- Markets per league in the latest stored hour
SELECT l.name, count(*) FROM pair_hours h JOIN leagues l ON l.id = h.league_id
WHERE h.source_hour = (SELECT max(source_hour) FROM raw_digests)
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

-- Responses rejected by validation
SELECT id, to_timestamp(request_cursor) AS hour, problems, fetched_at FROM rejected_responses;
```

`source_hour` is the hour the data describes; the matching `raw_digests` row says when we fetched it. Pricing semantics are still open; see [API observations](./specs/exchange-api-observations.md).

## Tests

```sh
npm test            # unit tests, plus PostgreSQL integration tests when TEST_DATABASE_URL is set
npm run typecheck
```

Integration tests need the database running (`npm run db:up`). They migrate and truncate the `pathofflipper_test` database, never the main one. Without `TEST_DATABASE_URL` they are reported as skipped.
