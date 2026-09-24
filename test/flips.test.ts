import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flipRow } from '../public/view.js';
import { crossFlip } from '../src/market/flips.ts';
import { rational } from '../src/market/semantics.ts';

const base = {
  buyLow: rational(30n, 1n),
  sellHigh: rational(1n, 5n), // 0.2 Divine per unit
  chaosPerDivine: 300,
  chaosTurnover: 300,
  divineTurnover: 2,
  itemFee: 50,
  divineFee: 250,
};

describe('crossFlip', () => {
  it('buys at the Chaos low, sells at the Divine high and values Divines at the Chaos/Divine rate', () => {
    const flip = crossFlip(base);
    assert.equal(flip.sellChaos, 60);
    assert.equal(flip.marginChaos, 30);
    assert.equal(flip.marginShare, 1);
    // The slower market limits the flip: 300 c/h against 2 div/h × 300 = 600 c/h.
    assert.equal(flip.turnoverChaos, 300);
    // Buying wants 1 unit (50 gold); selling wants 0.2 Divines (250 × 0.2 = 50 gold).
    assert.equal(flip.goldPerFlip, 100);
    assert.equal(flip.chaosPerKgold, 300);
    assert.equal(flip.score, 1 * 300 * 300);
  });

  it('reports losses and unknown gold', () => {
    const loss = crossFlip({ ...base, buyLow: rational(90n, 1n) });
    assert.equal(loss.marginChaos, -30);
    assert.ok(loss.score! < 0);
    const noFee = crossFlip({ ...base, itemFee: null });
    assert.deepEqual([noFee.goldPerFlip, noFee.chaosPerKgold, noFee.score], [null, null, null]);
  });
});

describe('flipRow', () => {
  it('shows the buy in Chaos, the sell in Divines and the margin in Chaos', () => {
    const row = flipRow({
      id: 'x',
      item: { name: 'Scarab', path: 'Metadata/Items/Scarabs/X', category: 'Scarabs', named: true },
      rank: 3,
      eligible: true,
      buy: { num: '30', den: '1', value: 30 },
      sell: { num: '1', den: '5', value: 0.2 },
      sell_chaos: 60,
      margin_chaos: 30,
      margin_share: 1,
      turnover_per_hour: 300,
      gold_per_flip: 100,
      chaos_per_1k_gold: 300,
      score: 90000,
      held: { hours: 5, checked: 6, lookback: 6, drift: 0.05, moving: false },
    });
    assert.deepEqual(
      [row.rank, row.buy, row.sell, row.sellChaos, row.margin, row.marginPct, row.gold, row.perGold, row.turnover, row.score, row.held, row.loss],
      ['3', '30.0c', '5.0 per div', '60.0c', '30.0c', '100%', '100', '300.0c', '300c/h', '90k', '5/6', false],
    );
  });
});
