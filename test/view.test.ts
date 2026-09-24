import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ageText,
  compact,
  DASH,
  DEFAULT_STATE,
  historySeries,
  differenceText,
  hourText,
  marketQuery,
  marketRow,
  percentText,
  rateText,
  searchFromState,
  stateFromSearch,
  statusBanner,
  statusCounts,
  volatilityText,
} from '../public/view.js';

const rate = (value: number) => ({ num: String(value), den: '1', value });

const market = {
  id: 'abc',
  item: { name: 'Divine Orb', path: 'Metadata/Items/Currency/CurrencyModValues', category: 'Currency', named: true },
  rank: 1,
  eligible: true,
  window_hours: 24,
  covered_hours: 18,
  traded_hours: 12,
  coverage: 0.75,
  persistence: 12 / 18,
  turnover_per_hour: 13437690,
  units_per_hour: 40897.9,
  volume: { quote: '1', base: '1' },
  rate: rate(328.5666),
  low_rate: rate(300),
  high_rate: rate(345),
  volatility: 0.0101,
  // Divine fee 250 + Chaos fee 15 × 345 = 5,425 gold; (345 − 300) / 5,425 × 1,000 = 8.29 Chaos per 1k gold.
  gold_per_flip: 5425,
  quote_per_1k_gold: 8.2949,
};

describe('number formatting', () => {
  it('compacts large numbers with at most one decimal', () => {
    assert.deepEqual(
      [13437690, 1966568, 40897.9, 9999, 328.57, 35.89, 4.058, 0.06914, 0, null].map((n) => compact(n)),
      ['13.4M', '2M', '40.9k', '9999', '329', '35.9', '4.1', '0.1', '0', DASH],
    );
  });

  it('shows Chaos rates with one decimal, as chaos each or per chaos below 1', () => {
    assert.equal(rateText(rate(328.5666)), '328.6c');
    assert.equal(rateText(rate(354)), '354.0c');
    assert.equal(rateText(rate(1234.44)), '1234.4c');
    assert.equal(rateText(rate(6.328)), '6.3c');
    assert.equal(rateText({ num: '1', den: '14', value: 1 / 14 }), '14.0 per c');
    assert.equal(rateText({ num: '200', den: '1937', value: 200 / 1937 }), '9.7 per c');
    assert.equal(rateText(null), DASH);
  });

  it('shows Divine prices in div', () => {
    assert.equal(rateText(rate(2.34), 'divine'), '2.3 div');
    assert.equal(rateText({ num: '1', den: '330', value: 1 / 330 }, 'divine'), '330.0 per div');
    assert.equal(differenceText(rate(2), rate(2.5), 'divine'), '0.5 div');
    assert.equal(marketRow({ ...market, turnover_per_hour: 42.25 }, 'divine').turnover, '42.3 div/h');
  });

  it('shows high minus low in the unit the prices are shown in', () => {
    assert.equal(differenceText(rate(354), rate(377)), '23.0c');
    assert.equal(differenceText(rate(6.328), rate(7)), '0.7c');
    // 10 per c to 9 per c: a Chaos difference of 0.011 would read 0.0c, so it stays in items per Chaos.
    assert.equal(differenceText({ num: '1', den: '10', value: 0.1 }, { num: '1', den: '9', value: 1 / 9 }), '1.0 per c');
    // Low below 1 Chaos, high at 1 Chaos: shown in Chaos like the high.
    assert.equal(differenceText({ num: '1', den: '18', value: 1 / 18 }, rate(1)), '0.9c');
    assert.deepEqual([differenceText(null, rate(1)), differenceText(rate(1), null)], [DASH, DASH]);
  });

  it('formats shares, volatility, ages and hours', () => {
    assert.deepEqual([percentText(0.25), percentText(1), percentText(null)], ['25%', '100%', DASH]);
    assert.deepEqual([volatilityText(0.0101), volatilityText(null)], ['±1.0%', DASH]);
    assert.deepEqual([ageText(0.5), ageText(22.61), ageText(72), ageText(null)], ['30 min', '22.6 h', '3 days', DASH]);
    assert.equal(hourText('2026-04-15T12:00:00.000Z'), '2026-04-15 12:00 UTC');
  });
});

describe('marketRow', () => {

  it('turns a market into display cells', () => {
    assert.deepEqual(marketRow(market), {
      id: 'abc',
      rank: '1',
      name: 'Divine Orb',
      category: 'Currency',
      unnamed: false,
      low: '300.0c',
      high: '345.0c',
      range: '45.0c',
      score: '16.7M', // (345 − 300) / 300 × 13,437,690 × 8.2949
      gold: '5425',
      perGold: '8.3c',
      turnover: '13.4Mc/h',
      units: '40.9k/h',
      traded: '12/18 h',
      coverage: '75%',
      volatility: '±1.0%',
      eligible: true,
      lowCoverage: false,
    });
  });

  it('shows unknown values as a dash rather than zero', () => {
    const row = marketRow({ ...market, rank: null, eligible: false, covered_hours: 0, traded_hours: 0, coverage: 0,
      turnover_per_hour: null, units_per_hour: null, rate: null, low_rate: null, high_rate: null, volatility: null });
    assert.deepEqual([row.rank, row.low, row.high, row.range, row.turnover, row.units, row.volatility], [DASH, DASH, DASH, DASH, DASH, DASH, DASH]);
    const noFees = marketRow({ ...market, gold_per_flip: null, quote_per_1k_gold: null });
    assert.deepEqual([noFees.gold, noFees.perGold], [DASH, DASH]);
    assert.equal(row.lowCoverage, true);
  });
});

describe('statusBanner', () => {
  const status = (problems: string[], stale: boolean, asOf: string | null = '2026-09-23T08:00:00.000Z') => ({
    data: { state: problems.length ? 'degraded' : 'ok', problems, source: { as_of_hour: asOf, source_age_hours: 1.5, stale } },
  });

  it('grades the data from ok to down', () => {
    assert.equal(statusBanner(status([], false)).level, 'ok');
    assert.equal(statusBanner(status(['gaps_last_24h'], false)).level, 'degraded');
    assert.equal(statusBanner(status(['stale_source'], true)).level, 'stale');
    assert.equal(statusBanner(status(['no_data', 'metrics_behind'], true, null)).level, 'down');
  });

  it('explains problems in words and states the data age', () => {
    const banner = statusBanner(status(['stale_source', 'something_new'], true));
    assert.equal(banner.text, 'Data up to 2026-09-23 08:00 UTC (1.5 h old)');
    assert.deepEqual(banner.problems, ['The newest exchange data is more than 3 hours old.', 'something_new']);
  });
});

describe('historySeries', () => {
  it('leaves unknown hours empty and gives covered hours without trades a zero volume', () => {
    const hour = (h: string, status: string, value?: number) => ({
      hour: `2026-04-15T${h}:00:00.000Z`,
      status,
      volume: value ? { quote: String(value * 10), base: '10' } : null,
      rate: value ? rate(value) : null,
      low_rate: value ? rate(value - 1) : null,
      high_rate: value ? rate(value + 1) : null,
      stock: null,
    });
    const series = historySeries({
      hours: [hour('10', 'missing'), hour('11', 'traded', 300), hour('12', 'inactive'), hour('13', 'exchange-down'), hour('14', 'listed')],
    });
    assert.deepEqual(series.x, [1776247200, 1776250800, 1776254400, 1776258000, 1776261600]);
    assert.deepEqual(series.low, [null, 299, null, null, null]);
    assert.deepEqual(series.high, [null, 301, null, null, null]);
    assert.deepEqual(series.turnover, [null, 3000, 0, null, 0]);
    assert.deepEqual(statusCounts(series.statuses).map((s) => [s.status, s.count]), [
      ['traded', 1],
      ['listed', 1],
      ['inactive', 1],
      ['exchange-down', 1],
      ['missing', 1],
    ]);
  });
});

describe('page state in the address bar', () => {
  it('round-trips and omits defaults', () => {
    const state = { ...DEFAULT_STATE, league: 'Hardcore Allflame', quote: 'flip' as const, window: '6h' as const, sort: 'margin' as const, q: 'scarab', offset: 50 };
    const search = searchFromState(state);
    assert.equal(search, '?league=Hardcore+Allflame&quote=flip&window=6h&sort=margin&q=scarab&offset=50');
    assert.deepEqual(stateFromSearch(search), state);
    assert.equal(searchFromState(DEFAULT_STATE), '');
  });

  it('falls back to defaults for invalid values', () => {
    assert.deepEqual(stateFromSearch('?window=2h&sort=rate&offset=-5&history=90d&scope=x'), DEFAULT_STATE);
  });

  it('builds the market list query', () => {
    assert.deepEqual(marketQuery({ ...DEFAULT_STATE, league: 'Allflame', quote: 'divine', q: 'orb', order: 'desc' }, 50), {
      league: 'Allflame',
      quote: 'divine',
      window: '1h',
      scope: 'eligible',
      sort: 'rank',
      limit: '50',
      offset: '0',
      order: 'desc',
      q: 'orb',
    });
  });
});
