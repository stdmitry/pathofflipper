# Currency exchange API observations

Status: observed 2026-09-23 against `https://web.poecdn.com/api/currency-exchange` while implementing [#9](https://github.com/stdmitry/pathofflipper/issues/9). These are measured behaviors, not documented guarantees; re-check them if collection starts failing.

## Cursor and hour behavior

- A request for cursor `T`, an hour-aligned unix timestamp, returns the markets for the hour starting at `T`, with `next_change_id = T + 3600`. This held across every consecutive hour fetched, including 2024-07-26 and 2026-09-22/23.
- **Recent history is directly accessible.** Requesting an hour from yesterday works immediately; catching up from the beginning of history is not required. The collector therefore bootstraps 24 hours back by default.
- A request without a cursor returns the earliest retained hour (2024-07-26 20:00 UTC on PC) with `next_change_id` one hour later. Requested this way, the source hour is `next_change_id - 3600`.
- **Current hour:** requesting the not-yet-completed hour returns HTTP 404 with body `{"next_change_id": T, "markets": []}`, where `T` is the requested cursor. The collector treats this as "caught up" and stops.
- A cursor that is not hour-aligned (e.g. `T + 1`) returns HTTP 404 with `{"error":{"code":1,"message":"Resource not found"}}`.
- The hour 08:00–09:00 UTC was already available at 09:00:01 UTC. A re-fetch a minute later returned a byte-identical body, meaning the same checksum. Published hours are served with `Cache-Control: max-age` of about one year, which suggests they are immutable once published.
- No `X-Rate-Limit-*` or `Retry-After` headers were seen on successful responses from this CDN host. The collector still honors them if they appear.

## Realms

The collector requests PoE 1 PC only ([#11](https://github.com/stdmitry/pathofflipper/issues/11)). The console observations below are kept for reference.

- PC has no path segment. `/pc/<cursor>` returns 404.
- `/xbox/<cursor>` and `/sony/<cursor>` return data (55 and 88 markets for 2026-09-23 06:00 UTC).
- `/sony` without a cursor returned 0 markets with `next_change_id = 1722027600`, an empty earliest hour.

## Payload shape

- Top level: `next_change_id` (number) and `markets` (array).
- Each market: `league`, `market_id` (`"<item a>|<item b>"`), `market_pair` (two item ids), and five maps keyed by the two item ids: `volume_traded`, `lowest_stock`, `highest_stock`, `lowest_ratio`, `highest_ratio`.
- All numeric values observed so far are integers, including ratios. The largest volume seen was 83,648,916. They are stored as exact `jsonb` numerics in case fractional or larger values appear.
- A recent PC hour held about 1,300–1,600 markets across 8 leagues, with about 75% showing nonzero traded volume. The earliest retained hour held 109 markets, of which 14 were active; the next hour, used as the fixture, holds 232.
- No duplicate `(league, market_id)` pairs were observed within a response. The collector rejects a response containing them rather than silently dropping rows.
- Response sizes: about 190 KB for 232 markets and about 1.1 MB for about 1,300 markets. Stored `jsonb` digests take about 130–145 KB each after PostgreSQL compression.

## Fixture

[`test/fixtures/pc-1722027600.json`](../test/fixtures/pc-1722027600.json) is the unmodified response for `GET /api/currency-exchange/1722027600` (PC, hour starting 2024-07-26 21:00 UTC, 232 markets, Settlers-era leagues). It contains only public market data.

## Still open

Ratio orientation, what the stock extrema measure, and whether both `volume_traded` values describe the same matched exchanges all remain unresolved ([#1](https://github.com/stdmitry/pathofflipper/issues/1)). The collector stores these fields verbatim and does not interpret them.
