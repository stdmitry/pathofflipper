# Path of Flipper

Research tooling for finding Path of Exile 1 currency-flipping opportunities on the in-game currency exchange. Project specifications live in [`specs/`](./specs/README.md).

The current slice ([#9](https://github.com/stdmitry/pathofflipper/issues/9)) fetches hourly currency exchange history from the [official API](https://www.pathofexile.com/developer/docs/reference#currencyexchange) into a local PostgreSQL database.

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
npm run fetch -- --realm xbox          # pc (default), xbox or sony
npm run fetch -- --help
```

Each run stores at most `--max-hours` completed hours (default 24, or `POE_MAX_HOURS`), then stops. It also stops early, with exit code 0, when it reaches the hour that hasn't been published yet. Failures exit with 1 and invalid options with 2.

**Bootstrap.** When a realm has no stored cursor, the first request is for 24 completed hours ago. Override that once with `--start`:

- `--start 2026-09-20T00:00Z` (any ISO time with a zone, on the hour)
- `--start 1790143200` (unix seconds, on the hour)
- `--start earliest` (the start of retained history, July 2024; catching up from there takes over 18,000 requests)

After the first stored hour, `--start` is ignored and runs continue from the cursor.

**Resuming.** Every hour commits its raw response, market rows and the advanced cursor in one transaction. If a run is interrupted, whether by Ctrl+C, a crash or a database outage, the next run continues from the last committed hour. The first Ctrl+C finishes the current hour and exits; a second aborts immediately, and the uncommitted hour is rolled back. Only one fetch per realm can run at a time.

**Failure handling.** Timeouts (30 s), network errors, HTTP 429 and 5xx are retried up to 5 attempts with exponential backoff, honoring `Retry-After` and the API's rate-limit headers. A response that fails validation is saved to `rejected_responses`, the cursor stays on that hour, and the run exits with 1. Requests identify the app through `User-Agent: pathofflipper/<version> (contact: $POE_USER_AGENT_CONTACT)`.

## Inspecting data

Open a shell with `npm run db:psql`, then for example:

```sql
-- Collection progress per realm
SELECT realm, to_timestamp(next_cursor) AS next_hour, last_success_at, last_error, last_error_at
FROM ingestion_cursors;

-- Stored hours
SELECT source_hour, market_count, first_fetched_at, checksum FROM raw_digests ORDER BY source_hour DESC LIMIT 10;

-- Markets per league in the latest stored hour
SELECT league, count(*) FROM market_hours
WHERE source_hour = (SELECT max(source_hour) FROM market_hours)
GROUP BY league ORDER BY 2 DESC;

-- Most traded markets in that hour; numeric fields are exact jsonb values keyed by item id
SELECT league, market_id, volume_traded, lowest_ratio, highest_ratio
FROM market_hours
WHERE source_hour = (SELECT max(source_hour) FROM market_hours)
ORDER BY (volume_traded->>item_a_id)::numeric DESC
LIMIT 10;

-- Responses rejected by validation
SELECT id, to_timestamp(request_cursor) AS hour, problems, fetched_at FROM rejected_responses;
```

`source_hour` is the hour the data describes, and `fetched_at` is when we retrieved it. `item_a_id` and `item_b_id` follow the upstream `market_pair` order and don't imply a buy or sell side. Pricing semantics are still open; see [API observations](./specs/exchange-api-observations.md).

## Tests

```sh
npm test            # unit tests, plus PostgreSQL integration tests when TEST_DATABASE_URL is set
npm run typecheck
```

Integration tests need the database running (`npm run db:up`). They migrate and truncate the `pathofflipper_test` database, never the main one. Without `TEST_DATABASE_URL` they are reported as skipped.
