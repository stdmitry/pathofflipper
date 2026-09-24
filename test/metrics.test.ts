import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { type MarketRecord, parseMarkets } from '../src/exchange/parse.ts';
import {
  activityRanks,
  basePerHour,
  coverage,
  ELIGIBILITY,
  isEligible,
  isStale,
  type MarketHour,
  persistence,
  quotePerHour,
  sourceAgeHours,
  windowMetrics,
} from '../src/market/metrics.ts';
import { type HourStatus, quoteHour, rational } from '../src/market/semantics.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pc-mirage-1776247200-3h.json', import.meta.url), 'utf8'),
) as { hours: { source_hour: number; body: unknown }[] };
const hours = fixture.hours.map((hour) => parseMarkets(JSON.stringify(hour.body)));

const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare';
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const CHROMATIC = 'Metadata/Items/Currency/CurrencyRerollSocketColours';

function record(hourIndex: number, other: string): MarketRecord {
  const found = hours[hourIndex]?.find((m) => m.pair.includes(CHAOS) && m.pair.includes(other));
  assert.ok(found);
  return found;
}

/** The fixture's three Chaos/`other` hours as traded hours, oldest first. */
const tradedHours = (other: string): MarketHour[] =>
  [0, 1, 2].map((i) => ({ status: 'traded', quoted: quoteHour(record(i, other), CHAOS) }));

/** A synthetic traded hour with `quote` chaos paid for `base` units, all at one rate. */
function trade(quote: number, base: number): MarketHour {
  const r = rational(BigInt(quote), BigInt(base));
  const ratio: [number, number] = [Number(r.num), Number(r.den)];
  const values = {
    volume_traded: [quote, base],
    lowest_stock: [0, 0],
    highest_stock: [0, 0],
    lowest_ratio: ratio,
    highest_ratio: ratio,
  } satisfies MarketRecord['values'];
  return { status: 'traded', quoted: quoteHour({ pair: [CHAOS, 'X'], values }, CHAOS) };
}

const status = (s: HourStatus): MarketHour => ({ status: s });

describe('windowMetrics', () => {
  it('sums each side separately and weights the rate by volume (Chaos/Divine, 3 real hours)', () => {
    const m = windowMetrics(tradedHours(DIVINE));
    const chaos = [0, 1, 2].map((i) => BigInt(record(i, DIVINE).values.volume_traded[0]));
    const divine = [0, 1, 2].map((i) => BigInt(record(i, DIVINE).values.volume_traded[1]));
    const total = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
    assert.equal(m.quoteVolume, total(chaos));
    assert.equal(m.baseVolume, total(divine));
    assert.deepEqual(m.rate, rational(total(chaos), total(divine)));
    assert.equal(quotePerHour(m), Number(total(chaos)) / 3, 'turnover counts the chaos side only');
    assert.equal(basePerHour(m), Number(total(divine)) / 3);
    assert.deepEqual([m.coveredHours, m.tradedHours, coverage(m), persistence(m)], [3, 3, 1, 1]);
  });

  it('takes the window extremes from the hourly extremes', () => {
    const m = windowMetrics(tradedHours(DIVINE));
    const quoted = tradedHours(DIVINE).map((h) => h.quoted!);
    const lows = quoted.map((q) => Number(q.lowRate!.num) / Number(q.lowRate!.den));
    const highs = quoted.map((q) => Number(q.highRate!.num) / Number(q.highRate!.den));
    assert.equal(Number(m.lowRate!.num) / Number(m.lowRate!.den), Math.min(...lows));
    assert.equal(Number(m.highRate!.num) / Number(m.highRate!.den), Math.max(...highs));
  });

  it('orients a pair with Chaos as item b the same way (Chromatic/Chaos)', () => {
    const m = windowMetrics(tradedHours(CHROMATIC));
    // Chromatics sell for a fraction of a Chaos Orb, so chaos per chromatic is below 1 and base volume is larger.
    assert.ok(m.rate && m.rate.num < m.rate.den);
    assert.ok(m.baseVolume > m.quoteVolume);
    assert.ok(m.lowRate && m.highRate && m.lowRate.num * m.highRate.den <= m.highRate.num * m.lowRate.den);
  });

  it('does not average hourly rates', () => {
    // 10 units at 300 and 1 unit at 1: the plain average of rates would be 150.5.
    const m = windowMetrics([trade(3000, 10), trade(1, 1)]);
    assert.deepEqual(m.rate, { num: 3001n, den: 11n });
  });

  it('keeps missing, exchange-down and league-absent hours out of coverage and per-hour values', () => {
    const m = windowMetrics([status('missing'), status('exchange-down'), status('league-absent'), trade(600, 2)]);
    assert.deepEqual([m.windowHours, m.coveredHours, m.tradedHours], [4, 1, 1]);
    assert.equal(coverage(m), 0.25);
    assert.equal(quotePerHour(m), 600, 'divided by the 1 covered hour, not the 4 in the window');
  });

  it('counts inactive and listed hours as covered with zero volume', () => {
    const m = windowMetrics([status('inactive'), { status: 'listed' }, trade(600, 2), trade(300, 1)]);
    assert.deepEqual([m.coveredHours, m.tradedHours, persistence(m)], [4, 2, 0.5]);
    assert.equal(quotePerHour(m), 225);
  });

  it('has no rate and no per-hour values without trades or coverage (zero denominators)', () => {
    const noTrades = windowMetrics([status('inactive'), status('listed')]);
    assert.equal(noTrades.rate, null);
    assert.equal(quotePerHour(noTrades), 0);
    assert.equal(persistence(noTrades), 0);

    const unknown = windowMetrics([status('missing'), status('exchange-down')]);
    assert.equal(unknown.coveredHours, 0);
    assert.equal(quotePerHour(unknown), null, 'unknown is not zero');
    assert.equal(basePerHour(unknown), null);
    assert.equal(persistence(unknown), 0);
    assert.equal(coverage(windowMetrics([])), 0);
  });

  describe('volatility', () => {
    it('is null with fewer than two traded hours', () => {
      assert.equal(windowMetrics([trade(300, 1)]).volatility, null);
      assert.equal(windowMetrics([trade(300, 1), status('inactive')]).volatility, null);
    });

    it('is 0 when every hour trades at the same rate', () => {
      const v = windowMetrics([trade(300, 1), trade(3000, 10)]).volatility;
      assert.ok(v !== null && v < 1e-12, `got ${v}`);
    });

    it('is the volume-weighted deviation of log rates', () => {
      // Equal quote volume at 100 and 400: log rates are ±ln 2 around their mean.
      const v = windowMetrics([trade(400, 4), trade(400, 1)]).volatility;
      assert.ok(v !== null && Math.abs(v - Math.log(2)) < 1e-12);
      // A tiny trade far away barely moves it.
      const small = windowMetrics([trade(30000, 100), trade(1, 1)]).volatility;
      assert.ok(small !== null && small < 0.2);
    });

    it('is small for the real Chaos/Divine hours', () => {
      const v = windowMetrics(tradedHours(DIVINE)).volatility;
      assert.ok(v !== null && v > 0 && v < 0.05, `got ${v}`);
    });
  });
});

describe('isEligible', () => {
  const full = (n: number, hour: () => MarketHour) => Array.from({ length: n }, hour);

  it('accepts a covered, persistent, active market', () => {
    assert.ok(isEligible(windowMetrics(full(24, () => trade(3000, 10)))));
  });

  it('rejects incomplete coverage', () => {
    const covered = Math.ceil(24 * ELIGIBILITY.minCoverage) - 1;
    const hours = [...full(24 - covered, () => status('missing')), ...full(covered, () => trade(3000, 10))];
    assert.equal(isEligible(windowMetrics(hours)), false);
  });

  it('rejects markets that rarely trade or trade little', () => {
    assert.equal(isEligible(windowMetrics([...full(13, () => status('inactive')), ...full(11, () => trade(3000, 10))])), false);
    assert.equal(isEligible(windowMetrics(full(24, () => trade(ELIGIBILITY.minQuotePerHour - 1, 1)))), false);
    assert.equal(isEligible(windowMetrics(full(24, () => status('listed')))), false);
  });
});

describe('activityRanks', () => {
  it('ranks eligible markets by chaos turnover, then persistence, then key; ineligible markets get none', () => {
    const market = (key: string, hours: MarketHour[]) => ({ key, sortKey: key, metrics: windowMetrics(hours) });
    const ranks = activityRanks([
      market('small', [trade(200, 1), trade(200, 1)]),
      market('big', [trade(9000, 30), trade(9000, 30)]),
      market('tie-b', [trade(500, 1), trade(500, 1)]),
      market('tie-a', [trade(500, 1), trade(500, 1)]),
      market('patchy', [trade(1000, 1), status('inactive')]),
      market('dead', [status('listed'), status('listed')]),
    ]);
    assert.deepEqual([...ranks], [
      ['big', 1],
      ['tie-a', 2],
      ['tie-b', 3],
      ['patchy', 4],
      ['small', 5],
    ]);
  });
});

describe('staleness', () => {
  const asOf = 1776254400; // 2026-04-15 12:00 UTC, complete at 13:00

  it('measures age from the end of the newest hour', () => {
    assert.equal(sourceAgeHours(asOf, new Date('2026-04-15T13:00:00Z')), 0);
    assert.equal(sourceAgeHours(asOf, new Date('2026-04-15T14:30:00Z')), 1.5);
  });

  it('marks data older than three hours as stale', () => {
    assert.equal(isStale(asOf, new Date('2026-04-15T16:00:00Z')), false);
    assert.equal(isStale(asOf, new Date('2026-04-15T16:00:01Z')), true);
  });
});
