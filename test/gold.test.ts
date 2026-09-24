import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadGoldFees, parseCsv, snapshotFromExport } from '../src/gold.ts';
import { flipGold, windowMetrics, type MarketHour } from '../src/market/metrics.ts';
import { quoteHour, rational } from '../src/market/semantics.ts';

describe('parseCsv', () => {
  it('handles quoted commas, quotes, newlines and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\n2,"multi\nline",\n3,,"[1,2]"';
    assert.deepEqual(parseCsv(text), [
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'multi\nline', ''],
      ['3', '', '[1,2]'],
    ]);
  });
});

describe('snapshotFromExport', () => {
  // The export's shape: CurrencyExchange.Item is a row number of BaseItemTypes, whose Id is the Metadata path.
  const baseItems =
    '"rownum","Id","ItemClassesKey","Name"\n' +
    '0,"Metadata/Items/Currency/CurrencyModValues",30,"Divine Orb"\n' +
    '1,"Metadata/Items/Currency/CurrencyRerollRare",30,"Chaos Orb"\n';
  const exchange =
    '"rownum","Item","Category","SubCategory","EnabledInStandardLeague","EnabledInChallengeLeague","GoldPurchaseFee","bool_54","bool_55"\n' +
    '0,1,0,0,1,1,15,"",1\n' +
    '1,0,0,0,1,1,250,"",1\n';

  it('maps fees to Metadata paths, sorted', () => {
    const snapshot = snapshotFromExport(exchange, baseItems, '3.29.3.3', new Date('2026-09-24T00:00:00Z'));
    assert.equal(snapshot.game_version, '3.29.3.3');
    assert.deepEqual(Object.entries(snapshot.fees), [
      ['Metadata/Items/Currency/CurrencyModValues', 250],
      ['Metadata/Items/Currency/CurrencyRerollRare', 15],
    ]);
  });

  it('refuses unknown items and invalid fees', () => {
    assert.throws(() => snapshotFromExport(exchange.replace('0,1,0,0', '0,9,0,0'), baseItems, 'v', new Date()), /unknown BaseItemTypes row 9/);
    assert.throws(() => snapshotFromExport(exchange.replace(',15,', ',-1,'), baseItems, 'v', new Date()), /fee -1/);
  });
});

describe('vendored fees', () => {
  it('has the reviewed fees of core currencies', async () => {
    const fees = await loadGoldFees();
    assert.ok(fees.size > 1000);
    assert.equal(fees.get('Metadata/Items/Currency/CurrencyRerollRare'), 15, 'Chaos Orb');
    assert.equal(fees.get('Metadata/Items/Currency/CurrencyModValues'), 250, 'Divine Orb');
    assert.equal(fees.get('Metadata/Items/Currency/CurrencyDuplicate'), 25000, 'Mirror of Kalandra');
  });
});

describe('flipGold', () => {
  /** One traded hour of Chaos (quote) for item X, with its own low and high. */
  function hour(low: number, high: number): MarketHour {
    const values = {
      volume_traded: [3000, 10],
      lowest_stock: [0, 0],
      highest_stock: [0, 0],
      lowest_ratio: [low, 1],
      highest_ratio: [high, 1],
    } as Record<'volume_traded' | 'lowest_stock' | 'highest_stock' | 'lowest_ratio' | 'highest_ratio', [number, number]>;
    return { status: 'traded', quoted: quoteHour({ pair: ['chaos', 'X'], values }, 'chaos') };
  }

  it('charges the wanted item fee per unit wanted on both legs', () => {
    // Buy 1 Divine (want 1 × 250 gold), sell it for 345 Chaos (want 345 × 15 gold): 5,425 gold for a 45 Chaos margin.
    const gold = flipGold(windowMetrics([hour(300, 345)]), 250, 15)!;
    assert.equal(gold.goldPerFlip, 5425);
    assert.ok(Math.abs(gold.quotePerKgold! - (45 / 5425) * 1000) < 1e-9);
  });

  it('prices cheap items per unit too', () => {
    // A chromatic between 1/18 and 1 Chaos: 20 gold to buy one, 15 × 1 to sell it for 1 Chaos.
    const m = windowMetrics([hour(1, 1)]);
    const cheap = { ...m, lowRate: rational(1n, 18n), highRate: rational(1n, 1n) };
    assert.equal(flipGold(cheap, 20, 15)!.goldPerFlip, 35);
  });

  it('is unknown without a fee or without trades', () => {
    assert.equal(flipGold(windowMetrics([hour(300, 345)]), null, 15), null);
    assert.equal(flipGold(windowMetrics([hour(300, 345)]), 250, null), null);
    assert.equal(flipGold(windowMetrics([{ status: 'inactive' }]), 250, 15), null);
  });
});
