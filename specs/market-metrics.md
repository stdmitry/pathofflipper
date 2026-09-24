# Market metrics

Status: calculation version 1, 2026-09-24 ([#4](https://github.com/stdmitry/pathofflipper/issues/4)). Code: [`src/market/metrics.ts`](../src/market/metrics.ts) (definitions) and [`src/metrics-run.ts`](../src/metrics-run.ts) (loading and storage). The field semantics these build on are in [API observations](./exchange-api-observations.md#field-semantics).

**These metrics rank market activity, not profitability.** A high rank means a lot of Chaos changed hands, steadily, in a market with complete data. It does not mean a flip in that market is profitable or will fill. Estimating profit over time is gated on [#7](https://github.com/stdmitry/pathofflipper/issues/7).

## Scope

- PoE 1 PC, every league present in the window, and markets **quoted directly in Chaos Orbs** (Chaos Orb is one of the pair's two items). Other pairs stay in `pair_hours` for later.
- Rates read as **Chaos per one unit of the other item** (the base). The upstream pair order is ignored: `quoteHour` re-orients every market.
- Windows are the last **1, 6 and 24 hours**, ending with the as-of hour. The as-of hour is the newest parsed hour by default.

## Hours

Each hour of a market's window gets a status from `classifyHour`:

| Status | Meaning | Covered |
|---|---|---|
| `missing` | No parsed response for the hour (not fetched, or fetched but not parsed yet) | No |
| `exchange-down` | The response had no markets at all (league launches, maintenance) | No |
| `league-absent` | The response had markets, but none in this league | No |
| `inactive` | The league is present, the market is not | Yes, zero volume |
| `listed` | A record with zero volume | Yes, zero volume |
| `traded` | A record with volume | Yes |

Unknown hours are never read as inactivity: every per-hour value divides by **covered** hours, and coverage is reported separately.

## Definitions

| Metric | Stored as | Definition |
|---|---|---|
| Coverage | `covered_hours` / `window_hours` | Share of the window's hours with usable data. |
| Activity persistence | `traded_hours` / `covered_hours` | Share of covered hours with trades. 0 when nothing is covered. |
| Turnover per hour | `quote_per_hour` | Chaos side of `volume_traded`, summed over the window, divided by covered hours. The base side is never added in. NULL when nothing is covered. |
| Traded units per hour | `base_per_hour` | The base item's side, the same way. |
| Rate | `rate_num` / `rate_den` | Total Chaos volume / total base volume: a volume-weighted rate, as an exact reduced fraction. Hourly rates are never averaged. NULL without trades. |
| Rate range | `low_rate_*`, `high_rate_*` | Lowest and highest executed rate in any hour of the window. Sensitive to single tiny trades; **not a spread**. |
| Volatility | `volatility` | Weighted standard deviation of the natural log of each traded hour's rate, weighted by that hour's Chaos volume. 0.05 is roughly ±5%. NULL with fewer than 2 traded hours, so always NULL for the 1h window. Logs make it independent of price level and orientation. |
| Freshness | `metric_runs.as_of_hour` | Readers compute the source age as `now − (as_of_hour + 1h)`. Data older than **3 hours** is stale. It is still shown, with its age, but marked degraded. Staleness is not stored, since it depends on when the data is read. |

## Eligibility and ranking

A market is **eligible** for a window when all of these hold:

| Threshold | Default | Why |
|---|---|---|
| Coverage | ≥ 75% | Keeps windows that overlap an outage or a collection gap from being compared with complete ones. At 24h this tolerates 6 unknown hours. |
| Persistence | ≥ 50% | Flipping needs a market that trades most hours, not one burst. |
| Turnover | ≥ 100 Chaos per covered hour | Removes markets that trade a few Chaos worth per hour. |
| Rate | present | At least one trade in the window. |

Eligible markets are ranked per league and window by **turnover per hour**, highest first. Ties go to the higher persistence, then to the lower pair id for a stable order. Ineligible markets are stored without a rank (`activity_rank IS NULL`), so they can still be looked up.

How the defaults were checked, on Mirage's 24h window ending 2026-04-15 12:00 UTC (mid-league, 1,023 Chaos markets, full coverage):

- Turnover quartiles were about 23, 440 and 4,800 Chaos/hour, with the 90th percentile about 25,000.
- The median persistence was 100%, the 25th percentile 37.5%.
- With the defaults, 645 markets are eligible. Raising turnover to 1,000 Chaos/hour would leave 427; dropping persistence to 25% would add 10.
- The top ranks were Divine Orb (328.6 c, range 300–345, volatility 0.010), The Black Barya, Valdo's Puzzle Box, Horned Scarab of Bloodlines and others. Stacked Deck (rank 7) shows why the range is not a spread: a 0.02 c low against a 4.06 c weighted rate.

Chaos turnover depends on each league's economy, so re-check these distributions at league start. Changing a threshold or definition means bumping `CALC_VERSION`.

## Storage and runs

- `npm run metrics` computes every window for every Chaos market with at least one row in the last 24 hours. It then replaces the stored snapshot for its calculation version in one transaction. Schedule it after `npm run parse`. `--as-of <hour>` recomputes an earlier hour, for reconciliation, and also replaces the snapshot; the next scheduled run restores the latest one.
- `metric_runs` holds one row per realm, quote item and calculation version, with `as_of_hour` and `computed_at`. `market_metrics` holds one row per league, pair and window. Older runs are not kept, because any run can be recomputed exactly from `pair_hours`. Keeping version *N* while version *N+1* is introduced lets a faulty calculation be switched back.
- A run takes about half a second on the real data: 2,103 markets and 6,309 rows at the Mirage peak. A BRIN index on `pair_hours.source_hour` lets it read only the window; the table is stored in hour order (correlation 1.0).

## Catalog

`items.display_name` comes from the vendored RePoE snapshot. All 1,135 stored items have a name. When an item is missing from the snapshot, readers show the last segment of its Metadata path. `items.category` is the third segment of the path (`Currency`, `DivinationCards`, `Scarabs`, `MapFragments`, …), for grouping and filtering.
