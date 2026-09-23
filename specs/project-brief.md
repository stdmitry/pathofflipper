# Project brief

## Purpose

Path of Flipper helps Path of Exile 1 players discover profitable currency-flipping opportunities on the in-game currency exchange: buying a currency at a lower price and selling it at a higher price.

Currency values change during a league. The application should help players compare opportunities using relevant market data and identify which currencies offer the most attractive potential returns. The primary objective is profit over time, accounting for market value and trading rate. High percentage returns are insufficient when purchases or resales remain pending for too long. Data sources and the exact estimation method remain open decisions.

## Intended users

Path of Exile players who want to earn in-game currency through trading. They need to identify promising buy-and-sell price differences and compare potential returns across currencies.

## Main user journey

Proposed workflow, pending confirmation:

1. Select the relevant league and platform for the in-game currency exchange.
2. Review currency-flipping opportunities ranked by estimated profit over time.
3. Inspect the purchase price, resale price, and calculation behind an opportunity.
4. Decide which currency to buy and resell.

## First release

The confirmed core capability is discovering the most profitable currencies to flip on the in-game currency exchange. Direct player trade listings and flips between trading venues are outside the first-release scope.

Proposed minimum scope, pending confirmation:

- Compare purchase and resale prices in a common reference currency.
- Show estimated profit per trade, percentage return, and profit per hour, with expected purchase and resale completion times.
- Rank opportunities and show when the underlying prices were observed.

Player-specific trading budgets are deferred. Trading execution, alerts, historical analysis, and support for multi-step exchanges have not been scoped.

API discovery and a proposed delivery sequence are documented in [Implementation plan](./implementation-plan.md). The historical API supports market screening; reliable fill-time and profit-per-hour estimates require additional validation before becoming release commitments.

## Proposed profitability model

Pending confirmation, use estimated net profit divided by the expected time to complete both purchase and resale as a starting point for profit per hour. Compare opportunities using a consistent capital budget and reference currency.

Completion-time estimates should account for trading activity, the chosen price, order size, and competing orders where data allows. Market-wide trading volume is an input, not a guarantee that a particular order will fill. The application should distinguish measured data from estimates and make uncertainty visible; the feasibility of estimating completion times must be validated against the available data.

## Constraints

The supported game is Path of Exile 1, and the trading venue is the in-game currency exchange. Platform, data sources, refresh frequency, budget, and timeline are undecided.

Profitability estimates will need a defined treatment of available trade quantities, capital requirements, transaction costs where applicable, and the likelihood of completing both sides of a trade. A displayed price difference alone does not establish a realizable profit.

## Success criteria

Proposed acceptance criteria, pending confirmation:

- A player can compare currency-flipping opportunities for their chosen market.
- Each opportunity shows the prices, units, and assumptions used to calculate its estimated return.
- The application makes the age of its market data visible.
- Rankings prioritize expected profit over time and account for market value and trading rate.
- A high-margin opportunity with a long expected wait is not ranked highly solely because of its percentage return.

## Open questions

1. How should we estimate trading rate and completion time, and what data is available to validate those estimates?
2. Should a later release support a maximum acceptable waiting time? Player-provided budgets are deferred.
3. Which leagues and platforms should be supported?
4. Which data sources can provide the required buy and sell prices and quantities?
5. Should the first release only discover opportunities, or also help track trades?

## Confirmed decisions

- Keep all project specifications in `/specs` within this repository.
- The project focuses on Path of Exile 1 currency flipping.
- The first release analyzes the in-game currency exchange only.
- Its core purpose is to discover the most profitable currencies to buy and resell.
- Currency values vary during a league.
- Profit over time is the primary objective, accounting for market value and trading rate.
- Long-pending trades are undesirable even when their percentage return is high.
- Player-specific trading budgets are deferred.
- Use GitHub Issues for project tracking.
- First implementation step: a currency-data fetching script with PostgreSQL setup and persistence, tracked in [issue #9](https://github.com/stdmitry/pathofflipper/issues/9).
