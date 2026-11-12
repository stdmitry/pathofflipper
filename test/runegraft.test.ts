import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  breakEvenBuyPrice,
  conversionProfit,
  expectedValue,
  findOpportunities,
  formatReport,
  loadWeights,
  parseWeights,
  recommendedBuyPrice,
  type RunegraftPrice,
  type RunegraftWeight,
} from '../src/market/runegraft.ts';

const weight = (name: string, probability: number | null): RunegraftWeight => ({ name, path: `RG/${name}`, probability });
const price = (name: string, buy: number, sell = buy): RunegraftPrice => ({
  name,
  path: `RG/${name}`,
  buyPriceChaos: buy,
  sellPriceChaos: sell,
  availableQuantity: null,
});

const near = (actual: number | null, expected: number) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
};

describe('expectedValue', () => {
  it('sums probability × price over outcomes priced above 20 chaos', () => {
    const weights = [weight('A', 0.5), weight('B', 0.3), weight('C', 0.2)];
    const prices = [price('A', 10), price('B', 100), price('C', 150)];
    const result = expectedValue(weights, prices);
    near(result.ev, 0.3 * 100 + 0.2 * 150);
    assert.equal(result.estimate, false);
    assert.deepEqual(result.warnings, []);
  });

  it('gives zero to outcomes priced at exactly 20 chaos or less', () => {
    const weights = [weight('A', 0.5), weight('B', 0.5)];
    const result = expectedValue(weights, [price('A', 20), price('B', 20.01)]);
    near(result.ev, 0.5 * 20.01);
    assert.deepEqual(result.counted.map((c) => c.name), ['B']);
  });

  it('values outcomes at the sell price, not the buy price', () => {
    const result = expectedValue([weight('A', 1)], [price('A', 5, 60)]);
    near(result.ev, 60);
  });

  it('honours a configured minimum outcome price', () => {
    const weights = [weight('A', 0.5), weight('B', 0.5)];
    const result = expectedValue(weights, [price('A', 30), price('B', 60)], { minOutcomePrice: 50 });
    near(result.ev, 30);
  });

  it('does not treat unknown probabilities as zero: they are reported and EV is an estimate', () => {
    const weights = [weight('A', 0.5), weight('B', null), weight('C', null)];
    const result = expectedValue(weights, [price('A', 100), price('B', 200), price('C', 5)]);
    near(result.ev, 50);
    assert.equal(result.estimate, true);
    // C is below the minimum, so its unknown probability does not matter for EV.
    assert.deepEqual(result.unknownProbability, ['B']);
    assert.match(result.warnings.join('\n'), /2 of 3 probabilities are unknown/);
  });

  it('shares the leftover probability among unknowns only when asked', () => {
    const weights = [weight('A', 0.5), weight('B', null), weight('C', null)];
    const result = expectedValue(weights, [price('A', 100), price('B', 200), price('C', 5)], { assumeUniformUnknown: true });
    near(result.ev, 0.5 * 100 + 0.25 * 200);
    assert.equal(result.estimate, true);
    assert.deepEqual(result.unknownProbability, []);
    assert.equal(result.counted.find((c) => c.name === 'B')?.assumed, true);
  });

  it('labels the EV an estimate when an outcome has no price', () => {
    const result = expectedValue([weight('A', 0.5), weight('B', 0.5)], [price('A', 100)]);
    near(result.ev, 50);
    assert.equal(result.estimate, true);
    assert.deepEqual(result.unpriced, ['B']);
  });

  it('labels the EV an estimate when known probabilities do not sum to 1', () => {
    const result = expectedValue([weight('A', 0.4), weight('B', 0.4)], [price('A', 100), price('B', 100)]);
    assert.equal(result.estimate, true);
    assert.match(result.warnings.join('\n'), /sum to 80\.00%/);
  });

  it('returns no EV when nothing can be counted', () => {
    const result = expectedValue([weight('A', null)], [price('A', 100)]);
    assert.equal(result.ev, null);
    assert.equal(result.estimate, true);
  });
});

describe('purchase thresholds', () => {
  it('matches the spec example: EV 60, break-even 20, 30% margin gives 14', () => {
    assert.equal(breakEvenBuyPrice(60), 20);
    near(recommendedBuyPrice(60), 14);
    near(recommendedBuyPrice(60, 0.5), 10);
    assert.equal(recommendedBuyPrice(60, 0), 20);
  });

  it('rejects a margin outside [0, 1)', () => {
    assert.throws(() => recommendedBuyPrice(60, 1), RangeError);
    assert.throws(() => recommendedBuyPrice(60, -0.1), RangeError);
  });

  it('computes profit from the actual cost of mixed inputs', () => {
    assert.equal(conversionProfit(60, [8, 8, 8]), 36);
    assert.equal(conversionProfit(60, [8, 10, 12]), 30);
    assert.throws(() => conversionProfit(60, [8, 10]), RangeError);
  });
});

describe('findOpportunities', () => {
  const prices = [price('C', 12), price('A', 8), price('Edge', 14), price('D', 30), price('B', 10)];

  it('returns only offers strictly below the recommended price, cheapest first', () => {
    const opportunities = findOpportunities(prices, 60);
    assert.deepEqual(opportunities.map((o) => o.name), ['A', 'B', 'C']);
    assert.deepEqual(opportunities.map((o) => o.expectedProfitPerConversion), [36, 30, 24]);
    near(opportunities[0]!.recommendedBuyPrice, 14);
    assert.equal(opportunities[0]!.availableQuantity, null);
  });

  it('scans every priced type against the same threshold', () => {
    assert.equal(findOpportunities(prices, 60, 0).length, 4);
    assert.equal(findOpportunities(prices, 6).length, 0);
  });
});

describe('weights file', () => {
  it('rejects zero-filled unknowns disguised as missing fields and bad probabilities', () => {
    assert.throws(() => parseWeights({ weights: [{ name: 'A', path: 'a' }] }), /probability/);
    assert.throws(() => parseWeights({ weights: [{ name: 'A', path: 'a', probability: 1.5 }] }), /probability/);
    assert.throws(() => parseWeights({ weights: [{ name: 'A', path: 'a', probability: 0.6 }, { name: 'B', path: 'b', probability: 0.6 }] }), /above 1/);
    assert.throws(() => parseWeights({ weights: [{ name: 'A', path: 'a', probability: null }, { name: 'B', path: 'a', probability: null }] }), /duplicate/);
  });

  it('loads the vendored file, listing every obtainable Runegraft', async () => {
    const weights = await loadWeights();
    assert.ok(weights.length >= 30);
    assert.ok(weights.every((w) => w.path.startsWith('Metadata/Items/Currency/Runegraft') && !w.name.startsWith('[DNT')));
  });
});

describe('formatReport', () => {
  const base = { league: 'Test', windowHours: 24, asOfIso: '2026-11-12T10:00:00Z', margin: 0.3, minOutcomePrice: 20 };

  it('prints EV, thresholds and the opportunities, and says quantity is unknown', () => {
    const weights = [weight('A', 0.6), weight('B', 0.4)];
    const prices = [price('A', 8, 50), price('B', 30, 75)];
    const text = formatReport({ ...base, weights, prices, evResult: expectedValue(weights, prices) });
    assert.match(text, /Expected Value: {7}60\.00 chaos\n/);
    assert.match(text, /Break-even Buy Price: 20\.00 chaos/);
    assert.match(text, /Recommended Buy: {6}14\.00 chaos/);
    assert.match(text, /A\n {2}Buy: {8}8\.00 chaos\n {2}Available: {2}unknown\n {2}Profit 3:1: \+36\.00 chaos/);
    assert.doesNotMatch(text, /\nB\n/);
    assert.match(text, /available quantity: unknown/);
  });

  it('labels an estimate and explains a missing EV', () => {
    const weights = [weight('A', null)];
    const prices = [price('A', 8, 50)];
    const text = formatReport({ ...base, weights, prices, evResult: expectedValue(weights, prices) });
    assert.match(text, /Expected Value: {7}unknown/);
    assert.match(text, /No opportunities: EV is unknown/);
    const estimate = formatReport({
      ...base,
      weights,
      prices,
      evResult: expectedValue(weights, prices, { assumeUniformUnknown: true }),
    });
    assert.match(estimate, /50\.00 chaos \(estimate\)/);
  });
});
