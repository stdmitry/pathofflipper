# Currency arbitrage audit report

Status: audit for [#25](https://github.com/stdmitry/pathofflipper/issues/25), 2026-11-12, following [the audit spec](./currency-arbitrage-audit.md). **No code has been changed.** The implementation plan in section E waits for approval.

Evidence comes from the code on branch `runegraft-conversion` (main at `6671d8c` plus the uncommitted Runegraft work) and from the local database: 18,949 parsed PC hours up to **2026-09-24 08:00 UTC**, metrics calculation version 5. Market measurements use the **Allflame** league, the busiest public league in that data (1,671 pairs and 18,353 traded rows in the last 24 hours). The data is seven weeks old, so the figures show what the code does, not what the market is doing now.

## Summary

1. **The system is a screener, not an arbitrage engine.** It ranks markets by the range of executed prices in a window. It has no order book, no trade sizes, no capital model and no profit per hour. That follows from the data source: the API publishes hourly aggregates of *executed* trades, and the project documents this honestly ([API observations](./exchange-api-observations.md#field-semantics)).
2. **P0: the Chaos → Divine view reports fictitious profits.** It buys at the window's lowest Chaos price and sells at the window's highest Divine price, so one odd trade on either side becomes the "margin". On real data the 24h view ranks Orb of Regret first at a **73,186%** margin. In the 1h window, Delirium Scarab of Mania ranks 3rd at **1,076%**. In the 24h window all 153 eligible items show a positive margin, so the "positive margin" filter removes nothing.
3. **P1: the triangle isn't closed.** The view values Divines at the volume-weighted Chaos/Divine rate but leaves out the Divine → Chaos trade and its gold. That trade costs 15 gold per Chaos wanted, about 5,400 gold per Divine, which is more than the rest of the flip's gold.
4. **P1: the most promising missing strategy is choosing the market to sell in (and to buy in).** For the same item, the volume-weighted Divine price converted to Chaos differs from the Chaos price by a median of **17%** (24h) to **29%** (1h). Among high-turnover items, those worth a fraction of a Divine sell for 9–23% more in the Divine market, and cheap scarabs sell for 5–40% less. Nothing in the code compares the two routes.
5. **P3: long cycles aren't worth building.** Pairs where neither item is Chaos or Divine carried 0.01% of traded value in the last 24 hours and 1.6% of traded rows over 30 days. A general cycle scanner would search a market that barely exists.

## A. Existing functionality

| Feature | Status | Code location | Notes |
|---|---|---|---|
| Chaos flipping `C → X → C` | **Partial** (screening only) | `src/market/metrics.ts:131` `rankScore`, `:171` `flipGold`; `src/metrics-run.ts:63` | Ranks by the window's (high − low) / low of executed prices. The spec itself says this is not a spread ([market-metrics.md](./market-metrics.md)). |
| Divine flipping `D → X → D` | **Partial** (screening only) | `src/market/quotes.ts:8`; `src/cli/metrics.ts:45` | Same calculation with Divine as the quote. Not limited to Chaos markets. |
| Triangular `C → X → D → C` | **Partial** | `src/market/flips.ts:43` `crossFlip`; `src/api/flips.ts:60` `listFlips` | Buys at the Chaos low, sells at the Divine high, and values Divines at the Chaos/Divine VWAP (`flips.ts:46`). It doesn't model the D → C trade or its gold (`flips.ts:50`). |
| Reverse triangular `D → X → C → D` | **Missing** | — | No query or function buys in a Divine market and sells in a Chaos market. |
| Direct C/D `C → D → C`, `D → C → D` | **Partial** | Chaos/Divine is an ordinary market in the Chaos snapshot | Screened like any `C → X → C` market. The two directions are the same trades, so they can't be told apart (see section 8). |
| Indirect purchase `C → D → X` vs `C → X` | **Missing** | — | Nothing compares the two routes. |
| Indirect sale `X → D → C` vs `X → C` | **Missing** (the cross view is the closest) | `src/api/flips.ts:103` | The cross view compares a Chaos buy with a Divine sale, but never compares selling the same item in its Chaos market vs its Divine market. |
| Effective price table per item | **Partial** | `market_metrics` (`src/metrics-run.ts:176`) | Per item and quote: VWAP, low and high, turnover, coverage, age. There is no separate buy and sell price because the data can't provide one, and no price at a given size. |
| Separate buy and sell prices | **Unable to verify / not supported by data** | `src/market/semantics.ts:9`, `:66` | Low and high are executed extremes, not bid and ask. The views use the low as "buy" and the high as "sell". |
| Integer lot sizes | **Missing** | `src/market/flips.ts:51`, test `test/flips.test.ts:25` | Everything is per unit, including 0.2 of a Divine wanted. No rounding, minimum lots or residual balances. |
| Liquidity on both sides | **Partial** | `src/market/flips.ts:49` | Uses turnover of the slower market as throughput. Stock is sampled without price levels and isn't used (correctly). There is no cap on how much size a recommendation consumes. |
| Slippage, multiple price levels | **Missing / not supported by data** | — | No depth data. |
| Shared liquidity between recommendations | **Missing** | — | Each row is independent. |
| Gold fees | **Implemented** (per unit, partly verified) | `src/gold.ts:4`, `data/gold-fees.json` (game 3.29.3.3), `src/market/metrics.ts:171` | Fee of the wanted item was checked in game. Scaling with quantity wasn't (`specs/market-metrics.md` Gold section). Gold is never converted to Divines, which is correct. |
| Gold balance and the cost of gold | **Missing** | — | Score uses "per 1k gold" only. |
| Residual currency tracking | **Missing** | — | No balances exist. |
| Profit levels (theoretical / executable / conservative / expected) | **Missing** | — | One "margin", an upper bound by its own description (`src/market/flips.ts:7`). |
| Never recommend negative profit | **Implemented** for the cross view | `src/api/flips.ts:148` | Requires `marginChaos > 0`, but the margin is extremes-based (P0-1), so this check almost never removes anything. |
| Trade size / capital optimization | **Missing** | — | Budgets were deferred in the [project brief](./project-brief.md). |
| Profit per hour | **Missing** (deliberately gated on [#7](https://github.com/stdmitry/pathofflipper/issues/7)) | `specs/implementation-plan.md` phase 5 | The score multiplies margin, turnover and gold efficiency. It isn't Divines per hour. |
| Quote freshness | **Implemented** | `src/market/metrics.ts:31` `STALE_AFTER_HOURS = 3`, `src/api/queries.ts:89` | Data is at least one hour old when published (hourly API). |
| Stale or unsynchronized snapshots | **Partial** | `src/api/flips.ts:62`, `:184` | The cross view reads two snapshots and reports only the Chaos one's age (P1-4). |
| Invalid / zero rates, duplicate markets | **Implemented** | `src/market/semantics.ts:44` (zero denominator throws), `src/exchange/parse.ts` (duplicates rejected) | |
| Persistence of an opportunity | **Implemented** (1h only) | `src/market/metrics.ts:202` `heldCheck`; `src/api/flips.ts:215` | Compares with 6 previous hours. The 24h cross view has no such check. |
| Inventory-aware selling | **Missing** | — | |
| Execution history / realized profit | **Missing** (tracked in #7) | — | |
| Multi-hop cycles | **Missing** (correctly) | — | See section 9. |
| Tests | **Partial** | `test/flips.test.ts`, `test/metrics.test.ts` | Cover the formulas as written, not executability. See section 11. |

**Duplicated functionality.** `hourlyMargins` (`src/api/flips.ts:215`) re-reads `pair_hours` and re-orients each hour itself. `checkHeld` (`src/metrics-run.ts:297`) does the same for single markets. These two can share one helper. Runegraft pricing (`src/runegraft-prices.ts:46`) takes the window low as the buy price, so it inherits P0-1.

## B. Problems found

### P0-1. The Chaos → Divine view turns single odd trades into margins

- **Where:** `src/market/flips.ts:44–48` (buy = `buyLow`, sell = `sellHigh × chaosPerDivine`), selected in `src/api/flips.ts:105–107` (`c.low_rate_*`, `d.high_rate_*`).
- **Reproduce:** run `listFlips` for Allflame against the stored snapshot (as of 2026-09-24 08:00).
  - 24h, rank 1: **Orb of Regret**, buy 0.50c, sell 366.4c, margin **73,186%**. The Divine "high" is one hour (04:00) with `highest_ratio` 1:1, one Divine paid for one Orb of Regret. The other 23 hours trade between 1/350 and 1/120 Divine.
  - 24h, ranks 2–3: Message in a Bottle 2,719%, Cosmic Fragment 18,222%. Valdo's Puzzle Box sells at 2 Divines (733c) against a 330c Chaos VWAP.
  - 1h, rank 3: **Delirium Scarab of Mania**, buy 3c, sell 35.3c, 1,076%. Its Divine market had 4 Divines of volume in the hour.
  - The inflated margin also switches off the `moving` check (`src/market/metrics.ts:211`, drift > margin). In 1h, Eldritch Exalted Orb drifted 189% over the 7 hours and Timeless Templar Emblem 379%, yet neither is "moving", because their margins are 1,708% and 827%. They rank 14th and 39th.
  - Eligible items with a positive margin: 153 of 153 (24h), 72 of 77 (1h). The reverse direction, buying at the Divine low and selling at the Chaos high, is also positive for 149 of 153 items (24h). Both directions can't be profitable at once, so the extremes don't measure an executable gap.
- **Impact:** the top of the ranking is dominated by fat-finger trades and coarse ratios. A player who acts on rank 1 would place a sell order at a price that one counterparty paid once.
- **Fix:** see E-1. Replace window extremes with a robust price basis, apply the persistence check to every window, and keep extremes only as "best seen" context.

### P0-2. A single trade makes a Divine market eligible in the 1h window

- **Where:** `src/market/quotes.ts:8` (`minPerHour: 0.3` Divine), `src/market/metrics.ts:116` `isEligible`. With a 1-hour window, coverage and persistence are 1/1 whenever anything traded.
- **Reproduce:** Allflame, 1h window: Ritual Scarab of Selectiveness has 1 Divine traded in its Divine market, yet both markets are eligible, giving a 2,052% cross margin. None of the 2 previous hours with trades held, so its score is 0, but it is still eligible (rank 59 of 60) and first when the eligible view is sorted by margin %.
- **Impact:** a rank (and visibility in the default "eligible" scope) for markets with one trade.
- **Fix:** see E-1. Make "held" part of eligibility in the 1h window instead of only a score multiplier, and require a minimum number of traded hours in the lookback for both markets.

### P1-1. The triangle isn't closed: no D → C trade and no gold for it

- **Where:** `src/market/flips.ts:46` values the sale at the window VWAP, and `:50–51` counts gold for the item buy and for the Divines wanted, but not for converting those Divines back to Chaos.
- **Reproduce:** an item sold for 1 Divine at the 1h rate of 361.6 c/div. Converting wants 361.6 Chaos at 15 gold each, about **5,424 gold**. The view counts item fee + 250 gold. The VWAP is also not the side a seller gets: the 1h Chaos/Divine range was 350–369.
- **Impact:** gold per flip is understated by up to an order of magnitude for Divine-priced items. "Chaos per 1k gold", and through it the score, are overstated. The Chaos margin assumes a conversion at the average rate.
- **Fix:** E-2. Report the sale in Divines and the cost in Chaos, and add the conversion as an explicit, optional leg with its own gold and a conservative rate.

### P1-2. Reverse triangle `D → X → C → D` missing

- **Where:** no code. `listFlips` only joins Chaos low with Divine high (`src/api/flips.ts:103–117`).
- **Impact:** half of the cross-market strategies are never looked at. Its value can't be measured until P0-1 is fixed, since on extremes it is positive almost everywhere.
- **Fix:** E-3. Generalize the cross view to both directions with one function.

### P1-3. No comparison of buying or selling the same item through Chaos vs Divine

- **Where:** no code.
- **Evidence (VWAP vs VWAP, both markets eligible, Allflame):** median gap 29% (1h) and 17% (24h). In the 24h window for the 10 highest-turnover items: Divination Scarab of The Cloister +12%, Valdo's Puzzle Box +12%, Stacked Deck +9%, Decaying Fragment +23%, Simulacrum +22%, Horned Scarab of Nemeses −29%, Essence Scarab of Calcification −40%. The Divine market pays more for items worth a large fraction of a Divine and less for cheap items.
- **Caveat:** VWAP mixes trades in both directions, so this is a gap in average executed prices, not proof that a seller gets that price. Divine-side prices are also coarse: the most common traded ratios in Divine markets over the last week were 1:1, 2:1, 1:2, 3:1, 4:1, 5:1 and 20:1 units per Divine.
- **Impact:** possibly the largest practical gain: no cycle needed, just routing purchases and sales (or liquidating inventory) through the better market.
- **Fix:** E-3 (effective price table with both routes per item).

### P1-4. Cross view can combine snapshots from different hours

- **Where:** `src/cli/metrics.ts:45` computes the Chaos and Divine snapshots one after the other, each taking `newestParsedHour` itself (`src/metrics-run.ts:69`). Parse holds a different lock (`src/ingest.ts:46` vs `:51`), so a parse can commit between them. `listFlips` never compares `chaosRun.asOfHour` with `divineRun.asOfHour`, and `meta` reports only the Chaos freshness (`src/api/flips.ts:184`). The same happens when one quote's run fails.
- **Reproduce:** run `npm run metrics` while `npm run parse` commits a new hour. Currently both stored runs are at 2026-09-24 08:00, so the stored data is consistent.
- **Impact:** in a moving market, buy and sell prices from different hours create or hide a margin.
- **Fix:** E-4. Resolve one as-of hour before the quote loop, and make `listFlips` refuse or flag mismatched snapshots.

### P1-5. No trade size, lot sizes, capital, or Divines per hour

- **Where:** whole pipeline. The per-unit model in `src/market/flips.ts` and `src/market/metrics.ts:171` treats 0.2 of a Divine as a quantity (`test/flips.test.ts:25`).
- **Impact:** profit at the sizes a 30-Divine budget implies is unknown. Divine-market lot granularity (above) makes per-unit figures especially wrong for items priced under one Divine.
- **Fix:** E-5. This is a design decision, not a bug: the project deferred budgets and profit per hour until trade observations exist (#7). The proposal is a lot-aware calculator at chosen sizes, labeled theoretical, not an optimizer.

### P2-1. Opportunity age

Every opportunity is at least one hour old when published, and up to `STALE_AFTER_HOURS` (3) before it is flagged. The API can't revalidate a quote before execution. The UI already says that it shows history. No fix proposed beyond keeping the age visible, but it bounds what any arbitrage feature can promise.

## C. Missed profit opportunities

| Opportunity | Source of profit | Why it is missed | Data needed | Complexity | Practical value | How to validate |
|---|---|---|---|---|---|---|
| Sell-market routing `X → D` vs `X → C` | Divine and Chaos markets price the same item differently (median gap 17–29%) | No per-item comparison | Existing VWAPs and hourly extremes | Low | Likely the highest; also covers inventory liquidation | Record real sell orders in both markets (#7) and compare realized prices with the VWAP gap |
| Buy-market routing `C → D → X` vs `C → X` | Same gap, other direction (cheap scarabs are cheaper via Divine) | Same | Same, plus the C/D rate for the conversion | Low | Medium: conversion adds a trade and its gold | Same, with purchases |
| Reverse triangle `D → X → C → D` | Items where the Chaos side pays more | Not implemented | Existing | Low after E-1 | Unknown until P0-1 is fixed | Count persistent opportunities on recorded hours, then real trades |
| Direction choice for C/D itself | The C/D rate swings within an hour (350–369 in the 1h window) | Screened like any market | Existing | — | Low: same limitation as any single market | Real trades |
| Inventory-aware liquidation | Items already held skip the buy leg | No inventory input | User-supplied balances | Medium | Medium; worth it only with sell routing | Manual |
| Capital allocation across opportunities | Several mid-size flips may beat one | No size model | Size-dependent fill evidence, which doesn't exist | High | Unknown | Needs #7 data first |
| Volume-dependent routing | Better route changes with size | No depth data | Order book; not available from the API | Not feasible with this data | — | — |
| Long cycles (4–5 hops) | Mispricing among non-C/D pairs | Not implemented | Existing | High | Very low (section 9) | — |

## Section 8: market data reliability

Established in [API observations](./exchange-api-observations.md) and re-checked here:

- **Fields:** per league and pair per hour: `volume_traded`, `lowest_stock`, `highest_stock`, `lowest_ratio`, `highest_ratio` for each side.
- **Live or aggregated:** hourly aggregates of executed trades, published after the hour ends and immutable afterwards. No live order book, no bid and ask, no individual trades or counts, no timestamps within the hour.
- **Volume:** traded units per hour are exact. Available volume isn't: stock is sampled and has no price levels.
- **Revalidation before execution:** not possible with this API. A quote can only be checked against the next published hour.
- **Handling in code:** zero rates are null (`semantics.ts:76`), zero denominators throw, duplicates and reversed pairs are rejected at parse, missing and exchange-down hours are kept out of coverage, staleness is flagged. Price change during multi-step execution isn't modeled.

Direction can't be recovered: a trade between someone buying X with Chaos and someone selling X for Chaos is one trade with one rate. So the data can't say whether the low was paid by a buyer or accepted by a seller. Any "buy at low, sell at high" figure is an upper bound that no order is guaranteed to reach.

## Section 9: are multi-hop cycles worth implementing?

Measured on Allflame:

| Pairs involving | Last 24h: pairs | Traded hours | Chaos value | 30 days: pairs | Traded rows |
|---|---|---|---|---|---|
| Chaos | 851 | 13,712 | 83.3M | 1,034 | 492,267 |
| Divine (not Chaos) | 419 | 4,448 | (see note) | 797 | 188,165 |
| Neither | 66 | 193 | **33,935 (≈ 0.01%)** | 707 | 11,219 (1.6%) |

Note: Divine-pair value is converted with each item's Chaos VWAP and is dominated by a few high-volume items, so only its order of magnitude is meaningful. The "neither" row is small under any conversion.

1. **What B finds that A misses:** cycles through pairs without Chaos or Divine. Those pairs trade in about 3 of every 24 hours each on average (193 traded hours over 66 pairs) and carry about 34k Chaos of value a day in total.
2. **Extra net profit:** can't be measured from executed extremes, for the reasons above. Even a large relative gap on 34k Chaos a day across all such pairs, before competition, is small next to the Chaos and Divine markets.
3. **Frequency, liquidity:** low and thin, as above.
4. **Extra exchanges:** every extra hop adds one more hourly-aggregate leg that can't be revalidated, plus its gold.
5. **Computational cost:** not an issue at 1,700 pairs; the market data is the limit.

**Recommendation: don't build Algorithm B.** Revisit only if a later league shows meaningful volume outside Chaos and Divine pairs (re-run the query in Appendix 2 at league start).

## Section 11: tests

Existing (`test/flips.test.ts`, `test/metrics.test.ts`): cross-flip arithmetic, loss sign, unknown gold, VWAP, extremes, held check, eligibility, staleness.

Missing from the spec's list, and testable with the current data model:

- Fat-finger extreme in one hour does not rank a flip (P0-1).
- Single-trade 1h market is not eligible (P0-2).
- Mismatched Chaos and Divine snapshot hours are flagged (P1-4).
- Conversion leg gold included (P1-1).
- Reverse triangle and route comparison (P1-2, P1-3).
- Negative margin after gold never eligible.
- Duplicate items in both directions don't both rank.

Not testable until a size model exists: lot divisibility, partial fills, residual balances, insufficient gold, limited capital, competing opportunities for the same liquidity. Property tests (no negative balances, no fractional quantities, conservation of assets) belong with E-5.

## D. Prioritized recommendations

**P0 (fictitious profit):**

1. **E-1:** robust price basis and persistence-based eligibility for the cross view (and the same basis for single-market screening and Runegraft buy prices).

**P1 (missing C/D strategies, wrong costs):**

2. **E-2:** close the triangle: explicit D → C leg with its gold, or report in Divines.
3. **E-3:** effective price table per item across both quotes, giving the reverse triangle and buy/sell routing.
4. **E-4:** synchronized snapshots for cross-market views.
5. **E-5:** lot-aware calculator at explicit trade sizes, reporting theoretical profit only.

**P2:** inventory-aware liquidation on top of E-3; execution log and realized Divines per hour as part of #7; capital allocation once #7 has data.

**P3:** multi-hop cycles (not recommended, section 9); volume-dependent routing (needs depth data the API doesn't have).

## E. Implementation plan

### E-1. Robust price basis (P0-1, P0-2)

- **Files:** `src/market/metrics.ts`, `src/metrics-run.ts`, `src/api/flips.ts`, `src/market/flips.ts`, `src/runegraft-prices.ts`, migration for new `market_metrics` columns, `specs/market-metrics.md`, `public/view.js`.
- **Interfaces:** `WindowMetrics` gains `typicalLow` and `typicalHigh`: the median of each traded hour's own low and high. `FlipInput.buyLow` / `sellHigh` become `buy` / `sell` with the basis named in the output. Bump `CALC_VERSION` to 6.
- **Algorithm:** medians of hourly extremes over traded hours (needs at least 3 traded hours in the window or lookback). A single fat-finger hour then moves the median by at most one rank. For the 1h window, take the median over the newest hour and its 6 lookback hours, and make `heldHours >= 3` an eligibility condition instead of only a score factor. Keep the window extremes as "best seen" columns.
- **Moving check:** compare drift with the typical margin, not the extreme one, so a fake margin can't hide a moving price.
- **Tests:** an Orb-of-Regret-like fixture (23 hours near 1/165 Divine, one hour at 1:1) doesn't rank; a single-trade Divine market isn't eligible in 1h; a steady gap present in every hour still ranks.
- **Regression risks:** rankings change for every view and the dashboard's columns change. Old snapshots stay readable under version 5.
- **Benefit:** removes the observed top-ranked false positives.
- **Dependencies:** none.

### E-2. Close the triangle (P1-1)

- **Files:** `src/market/flips.ts`, `src/api/flips.ts`, `public/view.js`, `test/flips.test.ts`.
- **Interfaces:** `Flip` gains `profitDivine` (sale in Divines minus cost converted at a stated rate) and, separately, `conversion: { rate, gold }` for the optional D → C leg, using the Chaos/Divine market's conservative side (its typical low from E-1) and gold = 15 × Chaos wanted.
- **Tests:** gold per flip includes the conversion when the view reports profit in Chaos; profit in Divines needs no conversion.
- **Risks:** score changes, since gold per flip grows for Divine-priced items.
- **Benefit:** correct gold, no hidden assumption about the conversion rate.
- **Dependencies:** E-1 for the conservative rate.

### E-3. Effective price table and routing (P1-2, P1-3)

- **Files:** new `src/market/routes.ts`; `src/api/flips.ts` becomes a thin reader of it; new endpoint or view mode in `src/api/server.ts` / `public/`.
- **Interfaces:** `ItemPrices { item, chaos: MarketPrices | null, divine: MarketPrices | null }` where `MarketPrices` holds VWAP, typical low and high, turnover, traded hours and age. `routes(item, cd)` returns the four cross routes (C→X→D, D→X→C, buy via C vs via D, sell via C vs via D), each with the prices used, gold and the basis label.
- **Algorithm:** pure comparisons per item; no search.
- **Tests:** each route on synthetic markets, both directions never both positive on the same consistent prices, missing market gives no route.
- **Risks:** low; additive.
- **Benefit:** covers spec strategies 3.3–3.7 with one model.
- **Dependencies:** E-1, E-2.

### E-4. Synchronized snapshots (P1-4)

- **Files:** `src/cli/metrics.ts`, `src/metrics-run.ts`, `src/api/flips.ts`.
- **Change:** resolve `asOfHour` once before the quote loop and pass it to both runs; `listFlips` returns `meta.mismatched_snapshots` (or no rows) when the two runs differ, and reports both ages.
- **Tests:** integration test with snapshots at different hours.
- **Risks:** minimal.
- **Dependencies:** none.

### E-5. Lot-aware calculator at explicit sizes (P1-5)

- **Files:** new `src/market/lots.ts`, then used by E-3.
- **Interfaces:** `evaluate(route, sizeInUnits)` returns integer quantities for each leg, residual balances, gold, and theoretical profit, rounding each leg conservatively (buy rounds up, sell rounds down) at the route's price basis.
- **Tests:** property tests: no negative balances, no fractional quantities, assets conserved apart from the stated prices; brute force on small sizes.
- **Risks:** presenting it as executable. Label it theoretical until #7 provides fill data.
- **Benefit:** realistic per-trade numbers at a 30-Divine budget.
- **Dependencies:** E-3. Divines per hour and capital allocation remain blocked on #7.

## Appendix: how the figures were produced

1. **Flip view ranks:** `listFlips(pool, { league: 'Allflame', window: 1 | 24, scope: 'eligible', sort: 'rank', order: 'asc', limit: 10, offset: 0 })` against the stored version 5 snapshot.
2. **Pair activity:** `pair_hours` for Allflame, rows with `volume_traded_a > 0`, grouped by whether the pair contains Chaos Orb (`CurrencyRerollRare`), Divine Orb (`CurrencyModValues`) or neither, over the 24 hours to 2026-09-24 08:00 and the 30 days before it. Values in Chaos use each item's 24h Chaos VWAP.
3. **Route gaps:** `market_metrics` joined across the Chaos and Divine runs for items whose two markets both have an `activity_rank`, comparing Divine VWAP × Chaos/Divine VWAP with the Chaos VWAP.
4. **Divine ratios:** most frequent `lowest_ratio` pairs in Divine markets (excluding Chaos/Divine) in the week to 2026-09-24.
