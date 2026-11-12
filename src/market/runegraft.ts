import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Runegraft 3:1 vendor conversion (spec: specs/runegraft-conversion-mvp-spec.md). Three Runegrafts of any kind give
 * one random Runegraft. One expected value (EV) of the outcome sets one buy threshold, and every Runegraft type is
 * scanned against it. Gold, fees and time are not included.
 *
 * Assumption, still unverified: the outcome distribution does not depend on which Runegrafts go in.
 */

export const RUNEGRAFT_WEIGHTS_FILE = path.join(import.meta.dirname, '..', '..', 'data', 'runegraft-weights.json');

/** Outcomes priced at or below this many chaos add nothing to EV. */
export const DEFAULT_MIN_OUTCOME_PRICE = 20;
export const DEFAULT_MARGIN = 0.3;
export const INPUTS_PER_CONVERSION = 3;

export interface RunegraftWeight {
  name: string;
  /** Metadata path; matches market data by item rather than by display name. */
  path: string;
  /** Chance of this outcome, 0..1; null when unknown. Unknown is never treated as 0. */
  probability: number | null;
}

export interface RunegraftPrice {
  name: string;
  path: string;
  /** Lowest executed Chaos price in the window: the buy side. */
  buyPriceChaos: number;
  /** Volume-weighted Chaos price in the window: what an outcome is worth. */
  sellPriceChaos: number;
  /** Units on offer; null because exchange history has no order book. */
  availableQuantity: number | null;
}

export interface RunegraftOpportunity {
  name: string;
  path: string;
  buyPriceChaos: number;
  recommendedBuyPrice: number;
  expectedProfitPerConversion: number;
  availableQuantity: number | null;
}

export interface EvOptions {
  /** Outcomes must be strictly above this price to count (default 20). */
  minOutcomePrice?: number;
  /**
   * Give outcomes of unknown probability an equal share of the probability left over by the known ones. Off by
   * default: it is an assumption, and the EV is then always labelled an estimate.
   */
  assumeUniformUnknown?: boolean;
}

export interface EvResult {
  /** Chaos per conversion; null when no outcome has both a probability and a price. */
  ev: number | null;
  /** True when the distribution or the prices are incomplete, so EV is an estimate. */
  estimate: boolean;
  /** Sum of the known probabilities. */
  knownProbability: number;
  /** Outcomes counted in EV (price above the minimum and a probability, known or assumed). */
  counted: { name: string; probability: number; priceChaos: number; assumed: boolean }[];
  /** Outcomes whose probability is unknown (and not assumed). */
  unknownProbability: string[];
  /** Outcomes with no price in the window, so whether they pass the minimum is unknown. */
  unpriced: string[];
  /** Human-readable reasons EV is an estimate or missing. */
  warnings: string[];
}

/** Probabilities in the weights file are rounded, so their sum may miss 1 by this much. */
const PROBABILITY_TOLERANCE = 1e-4;

/** Validates a parsed weights file; throws on anything that would silently change EV. */
export function parseWeights(data: unknown): RunegraftWeight[] {
  const weights = (data as { weights?: unknown } | null)?.weights;
  if (!Array.isArray(weights) || weights.length === 0) throw new Error('runegraft weights: "weights" must be a non-empty array');
  const seen = new Set<string>();
  const result = weights.map((entry: unknown, index): RunegraftWeight => {
    const { name, path: itemPath, probability } = (entry ?? {}) as Record<string, unknown>;
    const where = `runegraft weights[${index}]`;
    if (typeof name !== 'string' || name === '') throw new Error(`${where}: name must be a non-empty string`);
    if (typeof itemPath !== 'string' || itemPath === '') throw new Error(`${where}: path must be a non-empty string`);
    if (seen.has(itemPath)) throw new Error(`${where}: duplicate path ${itemPath}`);
    seen.add(itemPath);
    if (probability !== null && (typeof probability !== 'number' || !(probability >= 0 && probability <= 1))) {
      throw new Error(`${where}: probability must be a number in 0..1 or null (unknown)`);
    }
    return { name, path: itemPath, probability };
  });
  const known = result.reduce((sum, w) => sum + (w.probability ?? 0), 0);
  if (known > 1 + PROBABILITY_TOLERANCE) throw new Error(`runegraft weights: known probabilities sum to ${known}, above 1`);
  return result;
}

export async function loadWeights(file = RUNEGRAFT_WEIGHTS_FILE): Promise<RunegraftWeight[]> {
  return parseWeights(JSON.parse(await readFile(file, 'utf8')));
}

/** EV = Σ P_i × Price_i over outcomes priced strictly above the minimum. */
export function expectedValue(
  weights: readonly RunegraftWeight[],
  prices: readonly RunegraftPrice[],
  options: EvOptions = {},
): EvResult {
  const minPrice = options.minOutcomePrice ?? DEFAULT_MIN_OUTCOME_PRICE;
  const byPath = new Map(prices.map((p) => [p.path, p]));
  const knownProbability = weights.reduce((sum, w) => sum + (w.probability ?? 0), 0);
  const unknown = weights.filter((w) => w.probability === null);
  const leftover = Math.max(0, 1 - knownProbability);
  const assumedShare = options.assumeUniformUnknown && unknown.length > 0 ? leftover / unknown.length : null;

  const counted: EvResult['counted'] = [];
  const unknownProbability: string[] = [];
  const unpriced: string[] = [];
  for (const weight of weights) {
    const price = byPath.get(weight.path);
    if (!price) {
      unpriced.push(weight.name);
      continue;
    }
    if (!(price.sellPriceChaos > minPrice)) continue;
    if (weight.probability !== null) {
      counted.push({ name: weight.name, probability: weight.probability, priceChaos: price.sellPriceChaos, assumed: false });
    } else if (assumedShare !== null) {
      counted.push({ name: weight.name, probability: assumedShare, priceChaos: price.sellPriceChaos, assumed: true });
    } else {
      unknownProbability.push(weight.name);
    }
  }

  const warnings: string[] = [];
  if (unknown.length > 0) {
    warnings.push(
      assumedShare !== null
        ? `${unknown.length} of ${weights.length} probabilities are unknown; each was assumed to be ${formatPercent(assumedShare, 2)}`
        : `${unknown.length} of ${weights.length} probabilities are unknown and add nothing to EV`,
    );
  } else if (Math.abs(knownProbability - 1) > PROBABILITY_TOLERANCE) {
    warnings.push(`known probabilities sum to ${formatPercent(knownProbability, 2)}, not 100%`);
  }
  if (unpriced.length > 0) warnings.push(`${unpriced.length} outcomes have no price in the window and add nothing to EV`);

  const ev = counted.length === 0 ? null : counted.reduce((sum, c) => sum + c.probability * c.priceChaos, 0);
  if (ev === null) warnings.push(`no outcome priced above ${minPrice} chaos has a probability, so EV is unknown`);
  return { ev, estimate: warnings.length > 0, knownProbability, counted, unknownProbability, unpriced, warnings };
}

/** Break-even price per input Runegraft: EV / 3. */
export function breakEvenBuyPrice(ev: number): number {
  return ev / INPUTS_PER_CONVERSION;
}

/** EV / 3 × (1 − margin). */
export function recommendedBuyPrice(ev: number, margin = DEFAULT_MARGIN): number {
  if (!(margin >= 0 && margin < 1)) throw new RangeError(`margin must be in [0, 1), got ${margin}`);
  return breakEvenBuyPrice(ev) * (1 - margin);
}

/** EV minus the actual cost of the inputs; three of one kind is EV − 3 × price. */
export function conversionProfit(ev: number, inputPrices: readonly number[]): number {
  if (inputPrices.length !== INPUTS_PER_CONVERSION) {
    throw new RangeError(`a conversion takes ${INPUTS_PER_CONVERSION} Runegrafts, got ${inputPrices.length}`);
  }
  return ev - inputPrices.reduce((sum, price) => sum + price, 0);
}

/** Every priced Runegraft strictly below the recommended price, cheapest first. */
export function findOpportunities(prices: readonly RunegraftPrice[], ev: number, margin = DEFAULT_MARGIN): RunegraftOpportunity[] {
  const threshold = recommendedBuyPrice(ev, margin);
  return prices
    .filter((p) => p.buyPriceChaos < threshold)
    .map((p) => ({
      name: p.name,
      path: p.path,
      buyPriceChaos: p.buyPriceChaos,
      recommendedBuyPrice: threshold,
      expectedProfitPerConversion: conversionProfit(ev, [p.buyPriceChaos, p.buyPriceChaos, p.buyPriceChaos]),
      availableQuantity: p.availableQuantity,
    }))
    .sort((a, b) => a.buyPriceChaos - b.buyPriceChaos || a.name.localeCompare(b.name));
}

export interface RunegraftReportInput {
  league: string;
  windowHours: number;
  asOfIso: string | null;
  margin: number;
  minOutcomePrice: number;
  weights: readonly RunegraftWeight[];
  prices: readonly RunegraftPrice[];
  evResult: EvResult;
}

function formatPercent(share: number, digits = 0): string {
  return `${(share * 100).toFixed(digits)}%`;
}

const chaos = (value: number) => `${value.toFixed(2)} chaos`;
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} chaos`;

/** The text report of spec section 6, plus what is missing. */
export function formatReport(input: RunegraftReportInput): string {
  const { evResult: r } = input;
  const lines = [
    'Runegraft Conversion 3:1',
    '',
    `League:               ${input.league}`,
    `Prices:               ${input.windowHours}h window ending ${input.asOfIso ?? 'unknown'} (buy = lowest executed, value = volume-weighted)`,
    `Runegrafts priced:    ${input.prices.length} of ${input.weights.length}`,
    '',
  ];
  if (r.ev === null) {
    lines.push('Expected Value:       unknown');
  } else {
    const label = r.estimate ? ' (estimate)' : '';
    lines.push(
      `Expected Value:       ${chaos(r.ev)}${label}`,
      `Break-even Buy Price: ${chaos(breakEvenBuyPrice(r.ev))}`,
      `Recommended Buy:      ${chaos(recommendedBuyPrice(r.ev, input.margin))}`,
    );
  }
  lines.push(`Margin:               ${formatPercent(input.margin)}`, `Outcomes counted:     priced above ${input.minOutcomePrice} chaos`);
  lines.push('', 'Missing data:');
  for (const warning of r.warnings) lines.push(`  - ${warning}`);
  if (r.unknownProbability.length > 0) lines.push(`  - unknown probability, priced above the minimum: ${r.unknownProbability.join(', ')}`);
  if (r.unpriced.length > 0) lines.push(`  - no price: ${r.unpriced.join(', ')}`);
  lines.push('  - available quantity: unknown (exchange history has no order book)');

  if (r.ev === null) {
    lines.push('', 'No opportunities: EV is unknown. Fill in data/runegraft-weights.json or pass --assume-uniform.');
    return lines.join('\n');
  }
  const opportunities = findOpportunities(input.prices, r.ev, input.margin);
  lines.push('', opportunities.length === 0 ? 'Profitable purchases: none' : 'Profitable purchases:');
  for (const o of opportunities) {
    lines.push(
      '',
      o.name,
      `  Buy:        ${chaos(o.buyPriceChaos)}`,
      `  Available:  ${o.availableQuantity ?? 'unknown'}`,
      `  Profit 3:1: ${signed(o.expectedProfitPerConversion)}`,
    );
  }
  return lines.join('\n');
}
