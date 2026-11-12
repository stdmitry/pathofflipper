import { ELIGIBILITY } from '../market/metrics.ts';
import {
  breakEvenBuyPrice,
  conversionProfit,
  DEFAULT_MARGIN,
  DEFAULT_MIN_OUTCOME_PRICE,
  expectedValue,
  INPUTS_PER_CONVERSION,
  type RunegraftPrice,
  recommendedBuyPrice,
  type RunegraftWeight,
} from '../market/runegraft.ts';
import type { Draft, MarketRow } from './types.ts';

export interface RunegraftSummary {
  ev: number | null;
  break_even: number | null;
  recommended: number | null;
  margin: number;
  min_outcome_price: number;
  estimate: boolean;
  warnings: string[];
}

/**
 * One opportunity per priced Runegraft: buy three, vendor them 3:1 for a random Runegraft worth the shared EV. The
 * EV and threshold are those of `npm run runegraft` with its defaults. A row is eligible when its buy price is below
 * the recommended price and its Chaos market is covered and trades most hours. Gold counts the three buy orders only.
 */
export function runegraftOpportunities(
  weights: readonly RunegraftWeight[],
  prices: readonly RunegraftPrice[],
  marketOf: (path: string) => MarketRow | undefined,
  goldFee: (path: string) => number | null,
  options: { margin?: number; minOutcomePrice?: number } = {},
): { drafts: Draft[]; summary: RunegraftSummary } {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const minOutcomePrice = options.minOutcomePrice ?? DEFAULT_MIN_OUTCOME_PRICE;
  const r = expectedValue(weights, prices, { minOutcomePrice });
  const summary: RunegraftSummary = {
    ev: r.ev,
    break_even: r.ev === null ? null : breakEvenBuyPrice(r.ev),
    recommended: r.ev === null ? null : recommendedBuyPrice(r.ev, margin),
    margin,
    min_outcome_price: minOutcomePrice,
    estimate: r.estimate,
    warnings: r.warnings,
  };
  if (r.ev === null || summary.recommended === null) return { drafts: [], summary };
  const ev = r.ev;
  const threshold = summary.recommended;

  const drafts = prices.map((p): Draft => {
    const market = marketOf(p.path);
    const cost = p.buyPriceChaos * INPUTS_PER_CONVERSION;
    const profit = conversionProfit(ev, [p.buyPriceChaos, p.buyPriceChaos, p.buyPriceChaos]);
    const fee = goldFee(p.path);
    const gold = fee === null ? null : fee * INPUTS_PER_CONVERSION;
    const below = p.buyPriceChaos < threshold;
    const steady =
      market !== undefined && market.coverage >= ELIGIBILITY.minCoverage && market.persistence >= ELIGIBILITY.minPersistence;
    const warnings: string[] = [];
    if (!below) warnings.push(`Buy price ${p.buyPriceChaos.toFixed(1)}c is not below the recommended ${threshold.toFixed(1)}c`);
    if (!steady) warnings.push('Input market has gaps or trades in fewer than half of its hours');
    if (r.estimate) warnings.push(`EV is an estimate: ${r.warnings.join('; ')}`);
    if (gold === null) warnings.push('Gold fee unknown');
    const item = market?.item ?? { name: p.name, path: p.path, category: 'Currency', named: p.name !== p.path };
    return {
      id: `runegraft:${market?.id ?? p.path}`,
      kind: 'runegraft',
      title: `${p.name} ×${INPUTS_PER_CONVERSION} → random Runegraft`,
      item,
      legs: [
        { side: 'buy', label: p.name, item, quantity: INPUTS_PER_CONVERSION, price: p.buyPriceChaos, quote: 'chaos' },
        { side: 'expect', label: 'Random Runegraft (expected value)', item: null, quantity: 1, price: ev, quote: 'chaos' },
      ],
      cost_chaos: cost,
      return_chaos: ev,
      profit_chaos: profit,
      margin_share: profit / cost,
      gold_per_cycle: gold,
      chaos_per_1k_gold: gold === null || gold <= 0 ? null : (profit / gold) * 1000,
      cycles_per_hour: market?.units_per_hour == null ? null : market.units_per_hour / INPUTS_PER_CONVERSION,
      basis: r.estimate ? 'ev_estimate' : 'ev',
      eligible: below && steady,
      warnings,
      detail: {
        market_id: market?.id ?? null,
        inputs: INPUTS_PER_CONVERSION,
        ev,
        break_even: summary.break_even,
        threshold,
        margin,
        min_outcome_price: minOutcomePrice,
        counted: r.counted.map((c) => ({ name: c.name, probability: c.probability, price_chaos: c.priceChaos, contribution: c.probability * c.priceChaos })),
        unknown_probability: r.unknownProbability,
        unpriced: r.unpriced,
      },
    };
  });
  return { drafts, summary };
}
