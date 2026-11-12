# Technical Specification: Currency Arbitrage Scanner Audit & Optimization

## 1. Project Context

**Project:** PoE Economy AI — a system designed to identify the most profitable currency trading opportunities in Path of Exile.

**Technology stack:**
- TypeScript.
- Existing currency flipping system.
- Currency Exchange market data retrieved through HTTP requests.
- Typical available capital: 30+ Divine Orbs.
- Primary objective: maximize net profit in Divine Orbs per hour of real time.

The arbitrage functionality is already partially implemented.

**Your task is to audit the existing implementation, identify missing arbitrage opportunities, detect calculation errors, and recommend improvements that increase actual profitability.**

Do not rewrite existing modules or build a parallel system if the current implementation can be extended.

---

## 2. Audit Workflow

### Phase 1: Examine the Existing Codebase

Locate and analyze:

- Currency Exchange modules.
- Market data retrieval and caching.
- Arbitrage and flipping algorithms.
- Buy/sell exchange rate calculations.
- Chaos Orb and Divine Orb pricing logic.
- ROI, absolute profit, and div/hour calculations.
- Fees, rounding, liquidity, and volume handling.
- Quote freshness validation.
- Existing automated tests.

Determine:

1. Which arbitrage strategies are already implemented?
2. Which currency pairs are analyzed?
3. Are both exchange directions considered?
4. How is the optimal trade size determined?
5. How is actual trade executability evaluated?
6. What information does the current HTTP data source provide?
7. Is there duplicated functionality?

**Do not assume a feature is missing until you have verified the relevant code.**

Support every finding with file paths, function names, and line references.

---

## 3. Arbitrage Strategy Coverage

The main hypothesis is that most practically useful arbitrage opportunities can be discovered through Chaos Orbs and Divine Orbs without searching arbitrary long exchange cycles.

Definitions:

- `C` = Chaos Orb.
- `D` = Divine Orb.
- `X` = Any other tradable currency.

Verify support for the following strategies.

### 3.1. Direct Chaos Flipping

`C → X → C`

Buy currency X using Chaos Orbs and sell it back for more Chaos Orbs.

Verify:

- Are actual executable buy and sell rates used rather than average prices?
- Is the bid/ask spread handled correctly?
- Is liquidity checked on both sides?
- Is profit calculated after integer rounding?

### 3.2. Direct Divine Flipping

`D → X → D`

The same strategy using Divine Orbs.

Verify that the current implementation does not unintentionally restrict flipping to Chaos-based markets.

### 3.3. Triangular Arbitrage: Chaos to Divine

`C → X → D → C`

Buy X with Chaos, sell X for Divine, and convert Divine back to Chaos.

Verify:

- Are prices of the same currency compared across Chaos and Divine markets?
- Is the executable D → C conversion rate used?
- Are all three operations included in the calculations?
- Are integer lot sizes validated across the entire chain?

### 3.4. Reverse Triangular Arbitrage

`D → X → C → D`

Buy X with Divine, sell X for Chaos, and convert Chaos back to Divine.

This is not equivalent to the previous strategy because bid and ask prices differ.

### 3.5. Direct Chaos/Divine Arbitrage

`C → D → C`

`D → C → D`

Check whether the system can identify profitable discrepancies between opposite exchange directions, assuming the available market data supports this.

### 3.6. Indirect Currency Purchases

Consider a situation where the user wants to acquire currency X.

Instead of:

`C → X`

it might be cheaper to use:

`C → D → X`

Also evaluate the reverse scenario starting with Divine.

This does not necessarily represent a profitable closed cycle, but it can improve the effective acquisition price.

Check whether the existing system compares direct and indirect acquisition routes.

### 3.7. Indirect Currency Sales

Similarly, compare:

`X → C`

against:

`X → D → C`

Also evaluate routes ending in Divine.

Determine whether the system detects routes that maximize the amount of base currency received when liquidating existing inventory.

---

## 4. Unified Effective Price Model

Evaluate whether the system should maintain a unified table of effective prices for every currency X.

For each currency, calculate or retrieve:

- Best executable purchase price in Chaos.
- Best executable selling price in Chaos.
- Best executable purchase price in Divine.
- Best executable selling price in Divine.
- Equivalent prices after C/D conversion.
- Available liquidity for each direction.
- Quote age.
- Estimated execution time.

**Buy and sell prices must be modeled separately.**

Never use a single average price for both directions.

Prices must be evaluated at specific trade sizes. The best price for one unit may not be the best price for a large transaction.

Check whether a similar abstraction already exists and can be reused.

---

## 5. Profit Calculation Correctness

### 5.1. Integer Lot Sizes

Verify:

- Correct rounding behavior.
- Minimum exchange quantities.
- Lot-size divisibility.
- No fractional in-game currency items.
- Partial fill handling.
- Remaining currency balances after every exchange.

The system must never report profit based on fractional quantities that cannot actually be traded.

### 5.2. Liquidity and Slippage

Verify:

- Are available quantities considered?
- Are multiple price levels supported?
- Is slippage modeled?
- Is sufficient liquidity verified at every step?
- Can multiple recommended opportunities incorrectly consume the same available liquidity?

If the API does not expose exact liquidity, do not substitute invented values.

### 5.3. Trading Fees

Verify the current Currency Exchange Gold fee mechanics for the relevant PoE version.

Check whether the implementation accounts for:

- Gold required to place orders.
- Available Gold balance.
- Opportunity cost of obtaining Gold.
- Any other verified trading costs or restrictions.

Gold must not be treated as directly exchangeable for Divine Orbs.

### 5.4. Remaining Intermediate Currency

Example:

After completing a sequence, the user has:

- 10 Divine Orbs.
- 35 Chaos Orbs.
- 4 Ancient Orbs.

The system must not silently discard these balances or automatically treat them as fully liquid profit.

Verify:

- Complete tracking of final currency balances.
- Conservative valuation of remaining assets.
- Support for cycles that leave residual inventory.
- Separate reporting of profit in the starting currency and total portfolio value.

### 5.5. Strict Profit Validation

The system must never recommend operations with negative net profit.

Distinguish between:

- Theoretical profit based on exchange rates.
- Executable profit after integer lot constraints.
- Conservative net profit after all costs.
- Expected profit adjusted for execution risks.

Unknown fees or liquidity must not automatically be treated as zero-cost or unlimited.

---

## 6. Optimal Starting Capital

Review how the system determines trade size.

Maximizing ROI alone is insufficient.

Example:

- Trade A: 8% ROI, 0.08 Divine profit.
- Trade B: 3% ROI, 0.9 Divine profit.

With sufficient capital, Trade B may be significantly more attractive.

The system should determine:

1. Minimum executable trade size.
2. Trade size maximizing ROI.
3. Trade size maximizing absolute net profit.
4. Trade size maximizing expected div/hour.
5. Maximum executable volume based on liquidity.
6. Capital and Gold constraints.

Check whether the optimizer incorrectly assumes that profit is smooth, continuous, or monotonic.

Integer lot sizes and discrete liquidity levels can invalidate these assumptions.

---

## 7. Profit per Hour

The primary business metric is **net Divine Orbs per hour**, not ROI.

Verify whether the system accounts for:

- Order placement time.
- Expected fill time.
- Number of exchange operations.
- Partial fill probability.
- Order cancellation and replacement.
- Time required to liquidate remaining assets.
- Manual player interaction time.

Maintain separate metrics:

- `theoreticalDivPerHour`
- `expectedDivPerHour`
- `realizedDivPerHour`

If actual execution statistics are unavailable, use explicitly documented configurable assumptions.

Do not present estimated execution time as measured data.

---

## 8. Market Data Reliability

Inspect actual HTTP responses from the existing market data source.

Determine:

- Which fields are available?
- Are they live orders or aggregated prices?
- Are exact available volumes provided?
- Are timestamps available?
- How frequently are quotes updated?
- What API limitations apply?
- Can quotes be revalidated before execution?

Verify handling of:

- Stale quotes.
- Unsynchronized market snapshots.
- Missing updates.
- Invalid or zero exchange rates.
- Duplicate market entries.
- Price changes during multi-step execution.

Do not assume that the official API exposes a complete live order book.

---

## 9. Are Complex Arbitrage Cycles Worth Implementing?

Treat this as a separate research task.

Compare two approaches.

### Algorithm A: Base Currency Arbitrage

Only the Chaos/Divine-centered strategies described above.

### Algorithm B: General Multi-hop Arbitrage

Arbitrary simple directed cycles containing 2–5 exchanges.

Determine:

1. Which profitable opportunities does Algorithm B detect that Algorithm A misses?
2. What additional net profit do those opportunities offer?
3. How frequently do they occur?
4. Is sufficient liquidity available?
5. How many additional exchanges are required?
6. What is their expected profit per hour?
7. What is the computational cost of the broader search?

Use real recorded market snapshots whenever available.

If historical snapshots are insufficient, create synthetic benchmarks, but do not draw conclusions about actual market frequency or profitability from synthetic data.

**Do not implement a full general-purpose cycle scanner unless there is evidence that its additional complexity is justified.**

---

## 10. Additional Profit Opportunities

Investigate whether the following opportunities have been overlooked.

### 10.1. Volume-Dependent Routing

The optimal exchange route may depend on transaction size.

For example:

- Direct exchange is best for 1 Divine.
- Indirect exchange is best for 20 Divine because of market depth.

Check whether the routing logic accounts for transaction size and liquidity.

### 10.2. Capital Allocation Across Opportunities

With 30+ Divine available, executing several independent trades may outperform allocating all capital to one opportunity.

Evaluate:

- Joint optimization of multiple opportunities.
- Shared capital constraints.
- Shared liquidity.
- Active order slot limitations.
- Concurrent versus sequential execution.

### 10.3. Inventory-Aware Arbitrage

If the user already owns currency X, starting a new cycle from Chaos or Divine may be unnecessary.

Selling existing inventory through a favorable route may generate better returns.

Check whether current inventory balances are incorporated into opportunity selection.

### 10.4. Historical Signal Reliability

Some currency pairs may repeatedly appear profitable but fail during execution.

Evaluate whether the system tracks:

- Detected opportunities.
- Quote revalidation results.
- Disappearing quotes.
- Actual fills.
- Realized profit.
- Execution time.

Use historical execution reliability to adjust opportunity rankings.

### 10.5. Redundant Conversions

Identify routes containing unnecessary intermediate conversions.

Check whether removing a conversion preserves or increases profit.

However, fewer steps are not automatically better if the direct market has worse liquidity or pricing.

---

## 11. Testing Requirements

Review existing tests and identify missing coverage.

Required scenarios:

- Profitable direct Chaos flip.
- Profitable direct Divine flip.
- Profitable triangular arbitrage.
- Profitable reverse triangular arbitrage.
- Cheaper indirect purchase.
- Better indirect liquidation.
- Negative net profit after fees.
- Insufficient liquidity.
- Invalid lot divisibility.
- Partial fills.
- Residual intermediate currencies.
- Stale market quotes.
- Different optimal routes at different volumes.
- Insufficient Gold.
- Limited starting capital.
- Duplicate opportunities.
- Multiple opportunities competing for the same liquidity.

For small synthetic datasets, compare optimized results against exhaustive brute-force calculations.

Use property-based tests where appropriate.

Important invariants include:

- No negative inventory balances.
- No consumption beyond available liquidity.
- No fractional currency quantities.
- No unexplained creation or disappearance of assets.
- No executable recommendation with non-positive conservative net profit.

---

## 12. Required Audit Report

**Complete the audit before making any code changes.**

### A. Existing Functionality

Provide a coverage table:

| Feature | Status | Code Location | Notes |
|---|---|---|---|
| Chaos flipping | Implemented / Partial / Missing | File:line | ... |
| Divine flipping | ... | ... | ... |
| Cross-market arbitrage | ... | ... | ... |
| Capital optimization | ... | ... | ... |
| Liquidity validation | ... | ... | ... |

Include all relevant requirements from this specification.

Use `Unable to Verify` when the available evidence is insufficient.

### B. Identified Problems

For every issue, provide:

- Description.
- File and line references.
- Reproduction scenario.
- Impact on correctness or profitability.
- Proposed fix.
- Priority.

### C. Missing Profit Opportunities

For every opportunity, describe:

- Potential source of additional profit.
- Why the current implementation misses it.
- Required market data.
- Implementation complexity.
- Estimated practical value.
- How its value can be validated using real data.

Do not invent specific profitability percentages without measurements.

### D. Prioritized Recommendations

Classify improvements as follows.

**P0 — Critical**

Errors causing fictitious profits, invalid trade quantities, negative-profit recommendations, or incorrect liquidity calculations.

**P1 — High Priority**

Missing profitable Chaos/Divine strategies, capital optimization problems, or significant div/hour estimation errors.

**P2 — Medium Priority**

Improved routing, execution statistics, inventory management, and capital allocation.

**P3 — Research**

Arbitrary 4–5-hop cycles, advanced portfolio optimization, and other features with unverified practical profitability.

### E. Implementation Plan

For each recommended improvement, specify:

- Files to modify.
- Interfaces to extend.
- Algorithms to implement or correct.
- Tests to add.
- Regression risks.
- Expected benefit.
- Dependencies and prerequisites.

---

## 13. Constraints

- Do not rewrite working modules unnecessarily.
- Reuse the existing architecture whenever possible.
- Verify API capabilities before relying on them.
- Do not invent game mechanics, fees, or exchange behavior.
- Do not assume theoretical arbitrage is guaranteed to execute.
- Do not propose gameplay automation that violates GGG rules.
- Do not optimize ROI at the expense of real profit per hour.
- Do not introduce complex algorithms solely for architectural completeness.
- Do not modify code until the audit and implementation plan have been reviewed and approved.

---

## 14. Acceptance Criteria

The audit is complete when:

1. All relevant existing modules have been examined.
2. Implemented and missing strategies have been documented.
3. Profit calculations, fees, lot sizes, and liquidity handling have been verified.
4. Potential false-positive arbitrage signals have been identified.
5. Capital optimization has been evaluated.
6. The value of complex multi-hop cycle detection has been assessed.
7. Improvements have been prioritized.
8. Concrete changes and tests have been proposed for all P0/P1 findings.
9. Every code-related finding includes supporting source references.
10. No code changes have been made without approval.

---

## 15. Final Instructions to the Agent

Your goal is **not to build the most sophisticated arbitrage engine possible**.

Your goal is to identify the most valuable missing functionality and correctness issues in the existing system, with the ultimate objective of maximizing realistically executable net Divine Orbs per hour.

Focus especially on:

1. **Indirect buying and selling through Chaos/Divine.**
2. **Volume-aware pricing and optimal capital allocation.**
3. **Liquidity constraints and realistic execution profitability.**
4. **Missed arbitrage opportunities caused by incomplete strategy coverage.**
5. **Evidence-based evaluation of whether longer exchange cycles provide meaningful additional profit.**

Before recommending major architectural changes, demonstrate the problem using actual project code and, whenever possible, real market data.

**Deliver the audit report and a prioritized implementation plan first. Wait for explicit approval before modifying the code.**
