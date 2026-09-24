# Market metrics

Status: calculation version 3, 2026-09-24 ([#4](https://github.com/stdmitry/pathofflipper/issues/4); version 2 changed the ranking score, version 3 added gold). Code: [`src/market/metrics.ts`](../src/market/metrics.ts) (definitions) and [`src/metrics-run.ts`](../src/metrics-run.ts) (loading and storage). The field semantics these build on are in [API observations](./exchange-api-observations.md#field-semantics).

**The rank orders research candidates; it is not a profit estimate.** A high rank means a wide traded price range relative to the price, in a market where a lot of Chaos changes hands steadily and the data is complete. The range comes from executed trades at different moments, not from a spread anyone could capture, so a high rank does not mean a flip will fill or pay. Estimating profit over time is gated on [#7](https://github.com/stdmitry/pathofflipper/issues/7).

## Scope

- PoE 1 PC, every **public** league present in the window, and markets **quoted directly in Chaos Orbs or in Divine Orbs**, screened separately (`src/market/quotes.ts`). Each quote has its own snapshot and ranking. Prices, turnover and scores are in that quote's units, so they are not compared across quotes, and nothing is converted between them. (Chaos Orb is one of the pair's two items). Other pairs stay in `pair_hours` for later. Private leagues, named `… (PL<number>)` (`leagues.private`), are skipped: 2,002 of the first 2,034 stored leagues were private, and they are not markets a player can join.
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
| Turnover | ≥ 100 Chaos, or ≥ 0.3 Divine, per covered hour | Removes markets that trade a few Chaos worth per hour. The Divine minimum is about the same value at the ~330 Chaos per Divine seen in 2026. |
| Rate | present | At least one trade in the window. |

Eligible markets are ranked per league and window by their **score**, highest first:

> score = (high − low) / low × turnover per hour

`high` and `low` are the window's highest and lowest executed rates in Chaos per unit, so the first factor is the traded price range relative to the price, and the score is in Chaos per hour (`market_metrics.rank_score`). Ties go to the higher turnover, then to the lower pair id for a stable order. Ineligible markets are stored without a rank (`activity_rank IS NULL`) but keep their score, so they can still be looked up.

The eligibility thresholds matter more under this score. A single odd trade in a thin market can give a range of several hundred percent: Runegraft of the Fortress traded between 211c and 728c at 6 units per hour in Allflame. The ≥100c/h and ≥50% persistence thresholds keep such markets out of the ranking.

Version 1 (until 2026-09-24) ranked by turnover per hour alone.

How the defaults were checked, on Mirage's 24h window ending 2026-04-15 12:00 UTC (mid-league, 1,023 Chaos markets, full coverage):

- Turnover quartiles were about 23, 440 and 4,800 Chaos/hour, with the 90th percentile about 25,000.
- The median persistence was 100%, the 25th percentile 37.5%.
- With the defaults, 645 markets are eligible. Raising turnover to 1,000 Chaos/hour would leave 427; dropping persistence to 25% would add 10.
- Under version 1, the top ranks were Divine Orb (328.6 c, range 300–345, volatility 0.010), The Black Barya, Valdo's Puzzle Box, Horned Scarab of Bloodlines and others. Stacked Deck (rank 7) shows why the range is not a spread: a 0.02 c low against a 4.06 c weighted rate.

Chaos turnover depends on each league's economy, so re-check these distributions at league start. Changing a threshold or definition means bumping `CALC_VERSION`.

## Gold

Placing an exchange order costs gold, which cannot be traded, so gold is reported next to the quote-currency figures and never converted into them.

**Fees.** The game's `CurrencyExchange` table gives each exchange item a `GoldPurchaseFee` (e.g. Chaos Orb 15, Divine Orb 250, Mirror of Kalandra 25,000; median 150 over 1,126 items). [`data/gold-fees.json`](../data/gold-fees.json) vendors it from the RePoE fork's CSV export ([repoe-fork/dat-export](https://github.com/repoe-fork/dat-export)), with the game version it came from (3.29.3.3). `npm run gold-fees` copies it into `items.gold_fee`; `-- --download` refreshes the file first. Refresh once per league or patch, review the diff and commit it, then run `npm run metrics`.

**Rule.** An order's gold depends only on the item it *wants*: changing the offered item leaves the cost unchanged (checked in game, 2026-09-24). The cost is taken to be the wanted item's fee × the quantity wanted, which fits guides saying it scales in proportion to the amount but has not been checked in game.

**Per market** (`market_metrics.gold_per_flip`, `quote_per_kgold`), for one base unit at the window's prices:

> gold per flip = fee(base) × 1 + fee(quote) × high  
> quote per 1k gold = (high − low) / gold per flip × 1,000

Buying one unit wants 1 base unit, and selling it at the high wants `high` quote units. For expensive items the quote side dominates: flipping one Divine at 300c → 380c costs 250 + 15 × 380 = 5,950 gold for at most 80 Chaos, about 13.4 Chaos per 1,000 gold. Both figures use the range extremes, so the margin is an upper bound that one odd trade can inflate. On Allflame's 24h window the top Chaos markets by this measure were tattoos and fossils with lows of 1–3 Chaos against highs of 20–145. Items without a fee have NULL gold figures.

## Storage and runs

- `npm run metrics` computes every window for every Chaos market with at least one row in the last 24 hours. It then replaces the stored snapshot for its calculation version in one transaction. Schedule it after `npm run parse`. `--as-of <hour>` recomputes an earlier hour, for reconciliation, and also replaces the snapshot; the next scheduled run restores the latest one.
- `metric_runs` holds one row per realm, quote item and calculation version, with `as_of_hour` and `computed_at`. `market_metrics` holds one row per league, pair and window. Older runs are not kept, because any run can be recomputed exactly from `pair_hours`. Keeping version *N* while version *N+1* is introduced lets a faulty calculation be switched back.
- A run takes about half a second on the real data: 2,103 markets and 6,309 rows at the Mirage peak. A BRIN index on `pair_hours.source_hour` lets it read only the window; the table is stored in hour order (correlation 1.0).

## Catalog

`items.display_name` comes from the vendored RePoE snapshot. All 1,135 stored items have a name. When an item is missing from the snapshot, readers show the last segment of its Metadata path. `items.category` is the third segment of the path (`Currency`, `DivinationCards`, `Scarabs`, `MapFragments`, …), for grouping and filtering.
