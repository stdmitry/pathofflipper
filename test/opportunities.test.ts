import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flipOpportunity, tradeOpportunity } from '../src/opportunities/flips.ts';
import { compareBy, finish, type MarketRow, type Opportunity, rank } from '../src/opportunities/index.ts';
import { runegraftOpportunities } from '../src/opportunities/runegraft.ts';

const item = (name: string) => ({ name, path: `Metadata/Items/Currency/${name}`, category: 'Currency', named: true });

const market = (overrides: Partial<MarketRow> = {}): MarketRow => ({
  id: 'x',
  item: item('X'),
  rank: 1,
  eligible: true,
  gold_per_flip: 100,
  quote_per_1k_gold: 50,
  held: null,
  coverage: 1,
  persistence: 1,
  units_per_hour: 12,
  low_rate: { value: 20 },
  high_rate: { value: 25 },
  ...overrides,
});

describe('flipOpportunity', () => {
  it('buys at the low and sells at the high of one Chaos market', () => {
    const o = finish(flipOpportunity(market(), 'chaos', 300)!);
    assert.deepEqual(
      [o.id, o.kind, o.cost_chaos, o.return_chaos, o.profit_chaos, o.margin_share, o.cycles_per_hour, o.chaos_per_hour_ceiling],
      ['flip_chaos:x', 'flip_chaos', 20, 25, 5, 0.25, 12, 60],
    );
    assert.deepEqual([o.basis, o.eligible, o.chaos_per_1k_gold, o.warnings], ['range', true, 50, []]);
  });

  it('values a Divine market in Chaos at the window rate, and needs that rate', () => {
    const o = flipOpportunity(market({ low_rate: { value: 0.1 }, high_rate: { value: 0.2 }, quote_per_1k_gold: 0.5 }), 'divine', 300)!;
    assert.ok(Math.abs(o.cost_chaos - 30) < 1e-9 && Math.abs(o.profit_chaos - 30) < 1e-9);
    assert.equal(o.chaos_per_1k_gold, 150);
    assert.equal(flipOpportunity(market(), 'divine', null), null);
  });

  it('skips markets without trades and explains why a market is not ranked', () => {
    assert.equal(flipOpportunity(market({ low_rate: null }), 'chaos', 300), null);
    const thin = flipOpportunity(market({ eligible: false, rank: null, gold_per_flip: null }), 'chaos', 300)!;
    assert.equal(thin.eligible, false);
    assert.equal(thin.warnings.length, 2);
    const moving = flipOpportunity(
      market({ eligible: false, rank: null, held: { hours: 1, checked: 6, lookback: 6, drift: 0.4, moving: true } }),
      'chaos',
      300,
    )!;
    assert.deepEqual(moving.warnings, ['Price moving: 1 of 6 previous hours held the margin']);
  });
});

describe('tradeOpportunity', () => {
  const flip = {
    id: 'x',
    item: item('X'),
    eligible: true,
    buy: { value: 30 },
    sell: { value: 0.2 },
    sell_chaos: 60,
    margin_chaos: 30,
    margin_share: 1,
    gold_per_flip: 100,
    chaos_per_1k_gold: 300,
    held: null,
  };

  it('is limited by the slower of the two markets', () => {
    const o = finish(tradeOpportunity(flip, market({ units_per_hour: 10 }), market({ units_per_hour: 4 }), 300)!);
    assert.deepEqual([o.cost_chaos, o.return_chaos, o.profit_chaos, o.cycles_per_hour, o.chaos_per_hour_ceiling], [30, 60, 30, 4, 120]);
    assert.deepEqual(o.legs.map((l) => [l.side, l.quote, l.price]), [['buy', 'chaos', 30], ['sell', 'divine', 0.2]]);
  });

  it('has no cycle rate when a market is unknown, and says why a loss is not ranked', () => {
    assert.equal(tradeOpportunity(flip, undefined, market(), 300)!.cycles_per_hour, null);
    const loss = tradeOpportunity({ ...flip, eligible: false, margin_chaos: -5, margin_share: -0.1 }, market(), market(), 300)!;
    assert.match(loss.warnings[0]!, /pays less/);
  });
});

describe('runegraftOpportunities', () => {
  const weights = [
    { name: 'Cheap', path: 'Metadata/Items/Currency/RunegraftCheap', probability: 0.5 },
    { name: 'Dear', path: 'Metadata/Items/Currency/RunegraftDear', probability: 0.5 },
  ];
  const prices = [
    { name: 'Cheap', path: 'Metadata/Items/Currency/RunegraftCheap', buyPriceChaos: 10, sellPriceChaos: 12, availableQuantity: null },
    { name: 'Dear', path: 'Metadata/Items/Currency/RunegraftDear', buyPriceChaos: 80, sellPriceChaos: 90, availableQuantity: null },
  ];
  const markets = new Map([
    ['Metadata/Items/Currency/RunegraftCheap', market({ id: 'cheap', units_per_hour: 30 })],
    ['Metadata/Items/Currency/RunegraftDear', market({ id: 'dear' })],
  ]);

  it('uses one EV and one threshold, as the CLI does', () => {
    // EV counts only Dear (Cheap is worth 20c or less): 0.5 × 90 = 45; buy below 45 / 3 × 0.7 = 10.5.
    const { drafts, summary } = runegraftOpportunities(weights, prices, (p) => markets.get(p), () => 5);
    assert.equal(summary.ev, 45);
    assert.ok(Math.abs(summary.recommended! - 10.5) < 1e-9);
    assert.equal(summary.estimate, false);
    const [cheap, dear] = drafts.map(finish);
    assert.deepEqual(
      [cheap!.id, cheap!.cost_chaos, cheap!.return_chaos, cheap!.profit_chaos, cheap!.cycles_per_hour, cheap!.gold_per_cycle, cheap!.eligible, cheap!.basis],
      ['runegraft:cheap', 30, 45, 15, 10, 15, true, 'ev'],
    );
    assert.equal(cheap!.chaos_per_hour_ceiling, 150);
    assert.equal(dear!.eligible, false);
    assert.match(dear!.warnings[0]!, /not below the recommended 10.5c/);
  });

  it('marks an incomplete distribution as an estimate and a gappy input market as ineligible', () => {
    const partial = [...weights, { name: 'Unknown', path: 'Metadata/Items/Currency/RunegraftUnknown', probability: null }];
    const gappy = (p: string) => (p.endsWith('Cheap') ? market({ id: 'cheap', coverage: 0.5 }) : markets.get(p));
    const { drafts, summary } = runegraftOpportunities(partial, prices, gappy, () => null);
    assert.equal(summary.estimate, true);
    assert.equal(drafts[0]!.basis, 'ev_estimate');
    assert.equal(drafts[0]!.eligible, false);
    assert.equal(drafts[0]!.gold_per_cycle, null);
  });

  it('lists nothing when EV is unknown', () => {
    const unknown = weights.map((w) => ({ ...w, probability: null }));
    const { drafts, summary } = runegraftOpportunities(unknown, prices, (p) => markets.get(p), () => 5);
    assert.deepEqual([drafts, summary.ev], [[], null]);
  });
});

describe('ranking across kinds', () => {
  const o = (id: string, ceiling: number | null, eligible = true) =>
    ({ id, title: id, eligible, chaos_per_hour_ceiling: ceiling, profit_chaos: 1, rank: null }) as unknown as Opportunity;

  it('ranks eligible rows by ceiling with missing ceilings last, and leaves the others unranked', () => {
    const rows = [o('a', 10), o('b', null), o('c', 50), o('d', 99, false)];
    rank(rows);
    assert.deepEqual(rows.map((r) => [r.id, r.rank]), [['a', 2], ['b', 3], ['c', 1], ['d', null]]);
  });

  it('puts missing values last in either direction', () => {
    const rows = [o('a', 10), o('b', null), o('c', 50)];
    assert.deepEqual([...rows].sort(compareBy('ceiling', 'asc')).map((r) => r.id), ['a', 'c', 'b']);
    assert.deepEqual([...rows].sort(compareBy('ceiling', 'desc')).map((r) => r.id), ['c', 'a', 'b']);
  });
});
