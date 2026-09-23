# Currency exchange implementation plan

Status: proposed, 2026-09-21. This document proposes implementation; it does not approve a stack or claim that profitability estimation is already validated.

## Objective and scope

Help PoE 1 players find currency markets suitable for repeated, timely flips on the in-game exchange. Player-specific budgets are deferred. Proposed starting scope: PC, a selectable league, and pairs quoted directly in Chaos Orbs. These defaults remain proposals. Keep other pairs in storage for future expansion.

## Verified API facts

The [official reference](https://www.pathofexile.com/developer/docs/reference#currencyexchange) describes a public endpoint:

`GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]`

Omitting realm selects PoE 1 PC. Responses contain hourly historical market aggregates across leagues; the current hour is unavailable. Omitting the timestamp starts at the earliest history. Follow `next_change_id`; when it equals the requested timestamp, wait until the next hour. History may eventually be removed.

Markets include league, item identifiers, traded volumes, and stock/ratio extrema. These are not a live order book, individual fills, or order waiting times. The field descriptions do not sufficiently explain ratio/stock semantics for an execution model.

A real unauthenticated request was inspected during discovery: 109 markets, 14 with nonzero traded volume, and a continuation timestamp of 2024-07-26 21:00 UTC. This is an old bootstrap sample, not current market evidence. Zero-volume records must not be treated as completed trades.

## Consequence for the product

The API supports historical market screening. Our inference is that it cannot by itself establish executable spreads or credible personal profit per hour. A high-to-low price range may reflect price movement during the hour rather than an available flipping spread. Do not subtract historical extrema and call the result realizable profit.

Keep profit over time as the product objective, with a validation milestone before displaying estimated fill times or profit per hour. The initial screen can rank research candidates by sustained activity and price stability, clearly labeled as a market activity ranking rather than a profitability ranking.

## Phase 1: Validate data and pricing semantics

Build a small inspection script and retain sanitized response fixtures. Check multiple consecutive completed hours and several liquid and illiquid pairs. Verify:

- The timestamp-to-hour mapping, continuation behavior, and whether a recent explicit timestamp is accepted. The documentation describes cursors received from the endpoint; do not assume arbitrary historical seeking works.
- Ratio orientation, paired numerator/denominator interpretation, and what stock extrema measure. Obtain clarification if samples cannot establish semantics; never interpret the dictionary entries as independent prices.
- Whether traded amounts represent the two sides of the same matched exchanges; avoid counting both sides as separate demand or treating currency units as a trade count.
- Whether an absent pair in a successfully retrieved hour can be treated as inactive. Missing fetches always remain unknown.
- Mapping internal item identifiers to display names. Start with a reviewed local currency catalog; retain unknown IDs without crashing or guessing names.

Deliverable: fixtures, a documented normalization contract, and a decision on which metrics the data supports. If recent access requires replaying old history, measure the cost and implement a resumable, throttled catch-up rather than assuming immediate freshness.

## Phase 2: Collect and store history

Proposed architecture: one TypeScript web application, one scheduled worker, and PostgreSQL. A React interface is sufficient; framework and hosting selection can wait until implementation. Avoid adding queues or extra services before load requires them.

Flow: exchange endpoint → collector → raw digests and normalized markets → computed metrics → application API → browser.

Proposed tables:

- `ingestion_cursors`: realm, committed cursor, last success, retry state.
- `raw_digests`: realm, request cursor, returned cursor, fetch time, payload (kept permanently, lz4-compressed), checksum, parser version; unique by realm and hour.
- `items`: integer ID, Metadata path, display name seeded from a vendored RePoE snapshot (NULL when unknown).
- `pairs`: integer ID and both item IDs in upstream `market_pair` order; unique by the ordered pair.
- `leagues`: integer ID, realm, name.
- `pair_hours`: league ID, pair ID, hour, and the five volume/stock/ratio fields per side as `bigint`; primary key (league, pair, hour). Zero-volume rows are kept. Provenance joins on the hour to `raw_digests`.

Decided 2026-09-23: the original jsonb `market_hours` table (about 900 bytes per row, 10 GB at 9.5M rows) is replaced by the dictionaries and `pair_hours` above (about 120 bytes per row), rebuilt from `raw_digests`. Details and the cutover: [#13](https://github.com/stdmitry/pathofflipper/issues/13).
- `market_metrics`: market/window identifiers, coverage, normalized metrics, calculation version, computation time.

Commit digest, normalized rows, and cursor atomically. Replaying a cursor must not duplicate rows. Preserve integer amounts exactly and use decimal/rational arithmetic for ratios. Quarantine malformed records visibly, retaining the raw payload.

Fetch centrally, not once per browser. Catch up sequentially, then schedule after hourly boundaries with a short publication delay and bounded retries. Respect response rate-limit headers and `Retry-After`; back off on transient errors and stop retry loops on persistent client errors. These behaviors follow the [developer guidelines](https://www.pathofexile.com/developer/docs#ratelimits). Configure the prescribed identifying user agent before operation and include the required attribution notice before public release.

Use leagues observed in the exchange feed for the initial selector. Do not add a dependency on authenticated league discovery: the [developer overview](https://www.pathofexile.com/developer/docs#gettingstarted) currently says new application registrations are unavailable. An optional authenticated integration can be considered later.

## Phase 3: Build transparent market screening

Calculate metrics over proposed 1-hour, 6-hour, and 24-hour windows:

- Traded units per elapsed hour, including confirmed inactive hours.
- Quote-currency turnover per hour for directly quoted pairs, enabling comparable economic activity.
- Percentage of covered hours with completed trading activity.
- Price trend and volatility, only after normalization is validated.
- Data coverage and age, shown separately from market activity.

If matched-volume semantics are confirmed, use quote volume divided by target volume as a historical volume-weighted exchange rate. Aggregate volumes before division across a window; never average per-hour prices without weighting. Reject zero denominators. Do not present this historical rate as a currently executable buy or sell quote.

Initially sort eligible candidates by quote turnover, with filters for activity persistence and volatility. Display these factors directly rather than inventing a precise profitability score. Exclude zero-volume, stale, and inadequately covered markets from default results. Tune thresholds using observed distributions and record the chosen defaults.

## Phase 4: Deliver the interface

Provide a league selector, time window, searchable currency table, and market details. Each row shows historical market value, turnover/hour, activity persistence, volatility, and data freshness. The detail view explains the units and includes price/volume history.

Proposed internal endpoints:

- `GET /api/leagues`: realms and leagues observed in stored history.
- `GET /api/markets?realm=pc&league=...&quote=chaos&window=24h`: paginated candidates, metric definitions/version, coverage, and last completed source hour.
- `GET /api/markets/:id/history?realm=pc&league=...&window=24h`: time series with explicit gaps.
- `GET /api/status`: collection progress, last successful fetch, source age, and degraded status.

Use an internal opaque market identifier in URL paths. Validate window/sort/page parameters and bound query sizes. Cache read responses until the next committed digest. No user accounts or personal budget form are required for this proposed release.

## Phase 5: Validate profit-over-time estimates

Use a small, manually recorded evaluation dataset of actual buy/sell orders: price, size, placement time, partial fills, completion/cancellation, and realized proceeds. This is a research step, not a commitment to build trade tracking into the product. It requires user-supplied observations; this API does not provide those records.

Evaluate both legs and include pending/cancelled orders to avoid selecting only successful trades. Compare predictions using later chronological periods, with no future information in training features. Historical market replay alone cannot validate queue position or fill time.

If the evidence supports estimates, introduce standardized trade-size scenarios with explicit capital requirements while keeping personalized budgets deferred. Model gold requirements separately from tradable-currency proceeds unless an explicit conversion assumption is chosen. Return uncertainty ranges, not exact completion promises. Enable profitability sorting only after agreement on acceptable error and evaluation results; otherwise retain the clearly labeled research ranking and document that the original objective remains only partially met.

## Verification and release criteria

- Contract tests cover real response fixtures, zero volumes, unknown items, malformed records, and reciprocal price normalization.
- Collector integration tests cover retries, cursor persistence, crash recovery, repeat ingestion, empty/end-of-stream responses, and missing hours.
- Metric tests catch double-counting both currency sides, incorrect weighted prices, and treating gaps as zero activity.
- UI checks cover loading, no activity, stale data, ingestion errors, and market details consistent with stored fixtures.
- Before release, complete a continuous 48-hour collection run without duplicate hours or silent gaps. Reconcile selected UI metrics manually with raw digests.
- Monitor collection lag, missing hours, retry counts, normalization failures, and unknown item IDs. During upstream failure retain the last successful dataset and display its age.
- Version calculations so a faulty ranking can be disabled or reverted while preserving source data for recomputation. Deploy schema changes compatibly with the prior application version.

Recommended first implementation milestone: the data-validation script and resumable collector. Pricing semantics and access to recent history determine what the rest of the application can honestly promise.
