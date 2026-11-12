# Technical Specification: Runegraft 3:1 Arbitrage — MVP

## Objective

Develop a simple TypeScript module that identifies underpriced Runegrafts in Path of Exile based on the expected value (EV) of the random 3:1 vendor conversion recipe.

The module must integrate with the existing currency flipper, which already retrieves Currency Exchange market data via HTTP API.

## 1. Expected Value Calculation

Use a predefined probability distribution for Runegraft conversion outcomes, based on community experiments.

**Only include Runegrafts with a current market value strictly greater than 20 chaos in the EV calculation.**

$$
EV = \sum_{i:Price_i>20} P_i \times Price_i
$$

Where:
- `P_i` — probability of obtaining Runegraft `i`.
- `Price_i` — current selling price in chaos.
- Outcomes worth 20 chaos or less contribute zero to EV, but their probabilities remain part of the full distribution.

Store probabilities in a local `runegraft-weights.json` file. Unknown probabilities must be explicitly marked as unknown rather than assumed to be zero.

## 2. Recommended Purchase Price

Each conversion requires 3 Runegrafts.

$$
MaxBuyPrice = \frac{EV}{3}
$$

Apply a configurable safety margin (`margin`), defaulting to 30%:

$$
RecommendedBuyPrice = \frac{EV}{3}(1-margin)
$$

Example:
- Expected Value: 60 chaos
- Break-even purchase price: 20 chaos
- Safety margin: 30%
- Recommended purchase price: 14 chaos

This simplified model excludes gold costs, transaction fees, and time costs.

## 3. Market Scanner

Use the existing Currency Exchange HTTP API integration to retrieve current purchase offers for **all available Runegraft types**.

For each Runegraft:
1. Retrieve the lowest available purchase price.
2. Compare it against `RecommendedBuyPrice`.
3. If the price is strictly below the threshold, add it to the opportunity list.
4. Calculate expected profit per conversion:

$$
ExpectedProfit = EV - 3 \times BuyPrice
$$

For conversions using mixed Runegraft types, calculate expected profit using the actual total cost of the three input Runegrafts.

**Assumption:** The conversion outcome distribution is independent of the input Runegraft types. This assumption must be verified.

## 4. Data Structures

```typescript
interface RunegraftWeight {
  name: string;
  probability: number | null;
}

interface RunegraftPrice {
  name: string;
  buyPriceChaos: number;
  sellPriceChaos: number;
  availableQuantity: number;
}

interface RunegraftOpportunity {
  name: string;
  buyPriceChaos: number;
  recommendedBuyPrice: number;
  expectedProfitPerConversion: number;
  availableQuantity: number;
}
```

## 5. Execution Flow

1. Load conversion probabilities from `runegraft-weights.json`.
2. Fetch current market prices for all Runegrafts.
3. Identify output Runegrafts worth more than 20 chaos.
4. Calculate the expected conversion value (EV).
5. Calculate the recommended purchase price.
6. Scan all Runegraft types for offers below the recommended price.
7. Sort opportunities by ascending purchase price.
8. Display the results.

## 6. Example Output

*All values are illustrative.*

```text
Runegraft Conversion 3:1

Expected Value:       60.00 chaos
Break-even Buy Price: 20.00 chaos
Recommended Buy:      14.00 chaos
Margin:               30%

Profitable purchases:

Runegraft A
  Buy:        8 chaos
  Available:  120
  Profit 3:1: +36 chaos

Runegraft B
  Buy:        10 chaos
  Available:  75
  Profit 3:1: +30 chaos

Runegraft C
  Buy:        12 chaos
  Available:  40
  Profit 3:1: +24 chaos
```

## 7. MVP Scope and Exclusions

Do not implement:
- Monte Carlo simulations.
- Profit distribution calculations.
- Probability of loss.
- Automatic probability updates.
- Gold or time cost calculations.
- Capital optimization.
- Automated trading.

Reuse the existing currency flipper's market data adapter.

If the adapter does not provide the required prices or quantities, explicitly report missing data rather than inventing values.

If the probability distribution is incomplete or outdated, clearly label the calculated EV as an estimate.

## 8. Acceptance Criteria

- EV is correctly calculated using the configured probabilities and current market prices.
- Runegrafts priced at 20 chaos or less contribute zero to EV.
- The recommended purchase price correctly applies the configured safety margin.
- All available Runegraft types are scanned.
- Only offers strictly below the recommended purchase price are returned.
- Opportunities are sorted by ascending purchase price.
- The module integrates with the existing TypeScript project.
- Unit tests cover EV calculation, purchase thresholds, and opportunity filtering.

## Core Design Principle

**One shared expected value, one shared purchase threshold, and a market scanner covering every Runegraft type.**

The module should remain minimal and reuse as much of the existing currency flipper infrastructure as possible.

The primary goal is to identify Runegrafts that can be purchased below the EV-based threshold and converted through the 3:1 vendor recipe for positive expected profit.
