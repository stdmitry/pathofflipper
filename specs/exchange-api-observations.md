# Currency exchange API observations

Status: observed 2026-09-23; field semantics established 2026-09-24 against `https://web.poecdn.com/api/currency-exchange` while implementing [#9](https://github.com/stdmitry/pathofflipper/issues/9). These are measured behaviors, not documented guarantees; re-check them if collection starts failing.

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
- All numeric values observed so far are integers, including ratios. The largest value seen was 192,354,066. Since [#13](https://github.com/stdmitry/pathofflipper/issues/13) they are stored as `bigint` in `pair_hours`; a response with a fraction or a value beyond ±2^53 is rejected, and `raw_digests` keeps the exact original.
- `market_id` always equals `market_pair[0]|market_pair[1]`, and no pair has appeared in both orders across all 9,344 stored hours (2024-07-26 to 2026-09-23). The collector relies on both and rejects a response that breaks either.
- A recent PC hour held about 1,300–1,600 markets across 8 leagues, with about 75% showing nonzero traded volume. The earliest retained hour held 109 markets, of which 14 were active; the next hour, used as the fixture, holds 232.
- No duplicate `(league, market_id)` pairs were observed within a response. The collector rejects a response containing them rather than silently dropping rows.
- Response sizes: about 190 KB for 232 markets and about 1.1 MB for about 1,300 markets. Stored `jsonb` digests take about 130–145 KB each after PostgreSQL compression.

## Field semantics

Established for [#1](https://github.com/stdmitry/pathofflipper/issues/1) on 2026-09-24 from every stored PC `pair_hours` row: 20,814,232 rows, 16,257,925 with trades, from 2024-07-26 to 2026-05-17 plus 2026-09-22/23. The backfill of the hours in between was still running. The rules below are implemented in [`src/market/semantics.ts`](../src/market/semantics.ts). `npm run check-semantics` re-runs the invariants marked ✓ (all held with 0 exceptions); run it at every league start.

`a` and `b` are the two items in upstream `market_pair` order. That order is **not** a quote convention: Chaos Orb is item `a` in 641 stored pairs and item `b` in 491. Consumers must re-orient every market to their quote item (`quoteHour`) instead of reading `_a`/`_b` directly.

### `volume_traded`: both sides of the same trades

- ✓ Either both sides are 0 or neither is.
- ✓ `volume_traded[a] / volume_traded[b]` always lies within the hour's executed-rate extremes (below), and it equals them exactly whenever the two extremes are equal (855,509 rows in Mercenaries alone).
- Example: Chaos/Divine, Mercenaries, 2025-08-15 10:00 UTC: 1,637,252 Chaos for 11,831 Divine, which is 138.4 c/div, the known price at the time.

So `volume_traded[a]` units of `a` changed hands for `volume_traded[b]` units of `b`. The two sides describe one flow: never add them, and never count each side as separate demand. The values are currency units, not a number of trades; the API gives no trade count.

### `lowest_ratio` / `highest_ratio`: executed-rate extremes

- ✓ All four values are 0 exactly when nothing traded, and all are nonzero when something did. Listings alone never produce a ratio, so ratios describe executed trades, not asks or bids.
- ✓ Each ratio is a reduced fraction `ratio[a] : ratio[b]`, meaning `ratio[a]` units of `a` per `ratio[b]` units of `b` (Chaos/Divine above: `lowest_ratio` 129:1, `highest_ratio` 144:1).
- ✓ `lowest_ratio[a]/lowest_ratio[b] <= highest_ratio[a]/highest_ratio[b]`, so "lowest" and "highest" refer to the rate in `a` per `b`. For a market quoted in `b`, the lowest `b`-per-`a` rate is the inverse of `highest_ratio`.
- Single small trades can set a far-off extreme (a 1:1 Chaos/Divine low in the same hour as a 141:1 high). The range reflects dispersion and movement during the hour. It is **not** an available spread.

### `lowest_stock` / `highest_stock`: sampled resting orders

- ✓ `lowest_stock <= highest_stock` on each side, in units of that side's item (Chaos/Divine: about 1M Chaos against about 6k Divine, similar values).
- Stock is present without trades: 1,446,939 zero-volume rows have stock on both sides, meaning orders existed but did not cross.
- Trades exceed stock: in 28% of traded rows `volume_traded[a] > highest_stock[a]`. 86,794 rows traded with 0 stock on both sides.

So stock is the quantity sitting in unfilled orders at sample points during the hour. It is not the liquidity available over the hour. Orders that fill between samples never show up in it.

### Absent markets and empty hours

- A liquid pair (Chaos/Divine in Settlers, Mercenaries, Keepers, Mirage and Standard; 23,636 league-hours) was absent from a response only in two cases: the response had no markets at all, or it was the league's first or last partial hour.
- The same pair was absent in 180 Necro Settlers hours while the league was present. Nearly all of those fall in the event's final weeks, when it had 5–35 markets per hour. That is the expected `inactive` case for a market nobody trades.
- Illiquid markets appear only in hours when something was listed or traded (Mirage 2026-04-15: The Hunger is present only at 12:00, when it traded).
- 15 stored hours have `market_count = 0`, grouped around league launches and maintenance (2024-11-13/14, 2024-11-17/18, 2025-06-13, 2025-10-31, 2026-03-06). The exchange was down, and these hours say nothing about activity.
- 109,969 rows have zero volume and zero stock on both sides.

The metrics use `classifyHour`: no stored response means `missing`, an empty response means `exchange-down`, and no markets for the league means `league-absent`. None of these count as coverage. A market absent from a league that is otherwise present is `inactive`, meaning covered with zero volume. A zero-volume record is `listed`, and one with volume is `traded`.

### Still unresolved

- **Which orders stock counts.** The data is consistent with `stock[x]` being the quantity of `x` offered in unfilled orders, but nothing here separates "offering `x`" from "wanting `x`". The sampling frequency and the price levels of the orders are unknown.
- **Whether an absent market could have traded.** Inferred not, from the liquid-pair evidence above. It is not documented.
- **All-zero records.** What makes the API emit a record with no volume and no stock is unknown (possibly orders placed and cancelled between samples). They are treated as `listed`.
- **Partial fills.** Whether an extreme can come from a partial fill of a larger order is unknown. It does not change the rules above.

## Supported metrics

| Metric | Support | Rule |
|---|---|---|
| Traded units per hour, per item | Supported | One side's volume, divided by covered hours in the window. Sides are never summed. |
| Quote turnover per hour | Supported for pairs with the quote item | The quote side's volume per covered hour. Other pairs need a conversion rate, which is not defined yet. |
| Volume-weighted rate | Supported | `windowRate`: total quote volume / total base volume over the window. Hourly rates are never averaged. A zero denominator gives no rate. |
| Executed-rate range | Supported, with its limits labeled | Min of `lowRate` and max of `highRate`. Outlier-sensitive; not a spread. |
| Activity persistence | Supported | Traded hours / covered hours. |
| Coverage and age | Supported | Covered hours / hours in the window; age of the newest covered hour. |
| Volatility | Supported with care | Dispersion of hourly volume-weighted rates, weighted by volume. Hours without trades have no rate and must not count as zero. |
| Listing presence | Supported | Hours with nonzero stock. Only presence is supported, not depth. |
| Order-book depth, spread, fill time, profit | **Not supported** | Stock is sampled, and ratios are trade extremes rather than quotes. Validating profit needs real trade observations ([#7](https://github.com/stdmitry/pathofflipper/issues/7)). |
| Number of trades | **Not supported** | Volumes are units, not trade counts. |

## Fixtures

- [`test/fixtures/pc-1722027600.json`](../test/fixtures/pc-1722027600.json): the unmodified response for `GET /api/currency-exchange/1722027600` (PC, the hour starting 2024-07-26 21:00 UTC, 232 markets, Settlers-era leagues). It contains only public market data.
- [`test/fixtures/pc-mirage-1776247200-3h.json`](../test/fixtures/pc-mirage-1776247200-3h.json): three consecutive Mirage hours from 2026-04-15 10:00 UTC. The stored responses are trimmed to 7 markets, and their values are unmodified. The fixture covers a liquid pair with Chaos as item `a` (Divine) and one with Chaos as item `b` (Chromatic), a market present in one hour only (The Hunger), zero-volume markets with stock on one side (Mirror) and both sides (an Essence), a trade with no stock, and an all-zero record.
- The empty launch-hour response (2026-03-06 17:00 UTC, `{"markets": [], "next_change_id": 1772820000}`) is inlined in `test/semantics.test.ts`.
