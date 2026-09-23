# GitHub issue backlog

Status: published as [issues #1–#9](https://github.com/stdmitry/pathofflipper/issues) on 2026-09-23. Issues include priorities and acceptance criteria, with related work linked in their bodies.

Start with [#9: First step: fetch currency exchange data and set up PostgreSQL](https://github.com/stdmitry/pathofflipper/issues/9). This combines a bounded, manually runnable fetch script with local PostgreSQL setup, migrations, atomic persistence, and resume support. It is the initial implementation slice across #1–#3; their broader follow-up scope remains. PostgreSQL is confirmed; the script runtime remains undecided.

Priorities: P0 = foundation/data correctness; P1 = subsequent delivery. Local draft IDs are retained for traceability; each maps to the linked GitHub issue below.

Source: [Implementation plan](./implementation-plan.md). PC, Chaos-quoted pairs, and the technical stack remain proposed defaults. Personal trading budgets are deferred.

## PF-01: Validate exchange history access and pricing semantics

GitHub: [#1](https://github.com/stdmitry/pathofflipper/issues/1)

Priority: P0  
Depends on: None

Establish which API fields support reliable market metrics before implementing pricing calculations.

Acceptance criteria:

- [ ] Inspect consecutive completed hours and liquid, illiquid, and zero-volume markets; retain fixtures.
- [ ] Document cursor/hour mapping and validate a supported path to recent history.
- [ ] Document ratio orientation, stock semantics, volume interpretation, and absent-market behavior; mark unresolved semantics explicitly.
- [ ] Define supported metrics and test normalization against reviewed fixtures.

## PF-02: Set up the application and historical storage

GitHub: [#2](https://github.com/stdmitry/pathofflipper/issues/2)

Priority: P0  
Depends on: PF-01

Create the application foundation and persist source data for reproducible calculations. TypeScript and PostgreSQL remain proposed choices to settle during this task.

Acceptance criteria:

- [ ] Document stack selection and local startup instructions.
- [ ] Add migrations for cursors, raw digests, hourly markets, currency catalog, and versioned metrics.
- [ ] Enforce realm/league/hour/market uniqueness and preserve integer precision.
- [ ] Verify migrations and atomic transaction rollback in integration tests.

## PF-03: Implement a resumable hourly exchange collector

GitHub: [#3](https://github.com/stdmitry/pathofflipper/issues/3)

Priority: P0  
Depends on: PF-01, PF-02

Collect exchange history centrally without duplicate records or silent gaps.

Acceptance criteria:

- [ ] Persist raw data, normalized records, and cursor atomically; replay is idempotent.
- [ ] Resume after interruption and handle empty responses and end-of-stream correctly.
- [ ] Respect rate limits and Retry-After; use bounded retries and stop persistent client-error loops.
- [ ] Retain malformed data for inspection and expose collection lag and failures.
- [ ] Test crashes, retry behavior, duplicate ingestion, and missing-hour detection.

## PF-04: Add currency names and transparent market metrics

GitHub: [#4](https://github.com/stdmitry/pathofflipper/issues/4)

Priority: P1  
Depends on: PF-01, PF-03

Identify active markets using explainable historical metrics while profitability estimation remains unvalidated.

Acceptance criteria:

- [ ] Maintain a reviewed currency catalog with a safe unknown-ID fallback.
- [ ] Compute turnover/hour, traded units/hour, activity persistence, coverage, and freshness for 1h/6h/24h windows.
- [ ] Compute price and volatility only where PF-01 establishes valid semantics; use weighted aggregation.
- [ ] Keep missing hours distinct from confirmed inactivity and avoid double-counting currency sides.
- [ ] Document eligibility thresholds and ranking factors; label ranking as market activity, not realized profitability.
- [ ] Test zero denominators, price orientation, weighting, stale data, and incomplete coverage.

## PF-05: Expose market history and collector status through a read API

GitHub: [#5](https://github.com/stdmitry/pathofflipper/issues/5)

Priority: P1  
Depends on: PF-04

Serve stored metrics to the application without triggering upstream requests per user.

Acceptance criteria:

- [ ] Implement league, market list, market history, and collector status endpoints described in the implementation plan.
- [ ] Validate filters, bound pagination/window sizes, and use opaque market IDs.
- [ ] Return units, source timestamps, coverage, and calculation version; show explicit history gaps.
- [ ] Invalidate cached responses after committed ingestion and test error/empty responses.

## PF-06: Build the currency market discovery dashboard

GitHub: [#6](https://github.com/stdmitry/pathofflipper/issues/6)

Priority: P1  
Depends on: PF-05

Help players compare historical trading activity and inspect a market before deciding to trade.

Acceptance criteria:

- [ ] Provide league/window selection, currency search, sortable metrics, and price/volume details.
- [ ] Display historical value, turnover, persistence, volatility where supported, and source age.
- [ ] Handle loading, empty, stale, and failed collection states.
- [ ] Clearly distinguish historical screening from executable quotes or validated profit forecasts.
- [ ] Omit player-budget inputs; verify displayed values against stored fixtures.

## PF-07: Validate profit-over-time predictions against actual trades

GitHub: [#7](https://github.com/stdmitry/pathofflipper/issues/7)

Priority: P1 research; required before profit/hour claims  
Depends on: PF-01; PF-04 for model evaluation

Determine whether historical market signals can predict timely profitable flips; this remains essential to the original product objective.

Acceptance criteria:

- [ ] Define a manual observation format covering both trade legs, prices, quantities, partial fills, pending/cancelled orders, and realized proceeds.
- [ ] Obtain user-supplied observations without adding automated trade execution.
- [ ] Agree evaluation thresholds before testing and evaluate on later chronological data without future leakage.
- [ ] Report prediction error and uncertainty, including unsuccessful orders; record a go/no-go decision.
- [ ] Only enable estimated profit/hour after validation; otherwise document the unmet requirement.
- [ ] Use explicit standardized trade-size/capital assumptions if supported; keep personalized budgets deferred and gold requirements separate.

## PF-08: Verify collection reliability and prepare the screening release

GitHub: [#8](https://github.com/stdmitry/pathofflipper/issues/8)

Priority: P1  
Depends on: PF-03, PF-06

Release a clearly scoped market-screening tool with operational visibility and reproducible calculations.

Acceptance criteria:

- [ ] Complete a continuous 48-hour collection run with no duplicates or silent gaps.
- [ ] Reconcile selected dashboard metrics against source digests.
- [ ] Monitor lag, retries, malformed records, unknown items, and coverage; display stale data during outages.
- [ ] Document deployment, compatible migrations, and rollback/metric-recomputation procedures.
- [ ] Include the required third-party notice and configured identifying user agent.
- [ ] State that screening alone does not fulfill validated profit-over-time ranking; PF-07 gates those claims.
