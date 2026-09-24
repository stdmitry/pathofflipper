import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { interpretEnvelope, type MarketRecord, parseMarkets } from '../src/exchange/parse.ts';
import {
  classifyHour,
  compareRational,
  isCovered,
  quoteHour,
  rational,
  toNumber,
  windowRate,
} from '../src/market/semantics.ts';

// Three consecutive Mirage hours from 2026-04-15 10:00 UTC, trimmed to 7 markets (values unmodified).
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pc-mirage-1776247200-3h.json', import.meta.url), 'utf8'),
) as { hours: { source_hour: number; market_count: number; body: unknown }[] };

const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare';
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const CHROMATIC = 'Metadata/Items/Currency/CurrencyRerollSocketColours';
const HUNGER = 'Metadata/Items/DivinationCards/DivinationCardTheHunger';
const MIRROR = 'Metadata/Items/Currency/CurrencyDuplicate';
const ESSENCE = 'Metadata/Items/Currency/CurrencyEssenceContempt3';

const hours = fixture.hours.map((hour) => ({ ...hour, markets: parseMarkets(JSON.stringify(hour.body)) }));

function market(hourIndex: number, x: string, y: string): MarketRecord {
  const found = hours[hourIndex]?.markets.find((m) => m.pair.includes(x) && m.pair.includes(y));
  assert.ok(found, `fixture hour ${hourIndex} has no ${x}|${y}`);
  return found;
}

describe('fixture', () => {
  it('is three consecutive hours that the envelope check accepts', () => {
    fixture.hours.forEach((hour, index) => {
      assert.equal(hour.source_hour, 1776247200 + index * 3600);
      const result = interpretEnvelope(200, JSON.stringify(hour.body), hour.source_hour);
      assert.equal(result.kind, 'hour');
    });
  });

  it('has Chaos Orb on either side of a pair, so pair order is not a quote convention', () => {
    assert.deepEqual(market(0, CHAOS, DIVINE).pair, [CHAOS, DIVINE]);
    assert.deepEqual(market(0, CHAOS, CHROMATIC).pair, [CHROMATIC, CHAOS]);
  });
});

describe('quoteHour', () => {
  it('reads Chaos/Divine (Chaos is item a) as chaos per divine', () => {
    // volume 13,204,338 c for 40,466 div; ratios 305:1 and 330:1.
    const hour = quoteHour(market(0, CHAOS, DIVINE), CHAOS);
    assert.equal(hour.base, DIVINE);
    assert.equal(hour.quoteVolume, 13204338n);
    assert.equal(hour.baseVolume, 40466n);
    assert.deepEqual(hour.lowRate, { num: 305n, den: 1n });
    assert.deepEqual(hour.highRate, { num: 330n, den: 1n });
    assert.ok(hour.rate);
    assert.equal(toNumber(hour.rate).toFixed(2), '326.31');
    assert.equal(hour.baseStock.high, 9024n);
    assert.equal(hour.quoteStock.high, 5075807n);
  });

  it('inverts Chromatic/Chaos (Chaos is item b) and keeps low <= high', () => {
    // Upstream ratios are chromatic per chaos, 12:1 to 18:1, so chaos per chromatic runs from 1/18 to 1/12.
    const hour = quoteHour(market(0, CHAOS, CHROMATIC), CHAOS);
    assert.equal(hour.base, CHROMATIC);
    assert.equal(hour.baseVolume, 194362n);
    assert.equal(hour.quoteVolume, 12787n);
    assert.deepEqual(hour.lowRate, { num: 1n, den: 18n });
    assert.deepEqual(hour.highRate, { num: 1n, den: 12n });
  });

  it('keeps the volume-weighted rate within the extremes in both orientations', () => {
    for (const { markets } of hours) {
      for (const record of markets) {
        for (const quote of record.pair) {
          const hour = quoteHour(record, quote);
          if (!hour.rate || !hour.lowRate || !hour.highRate) continue;
          assert.ok(compareRational(hour.lowRate, hour.rate) <= 0, `${record.pair.join('|')} low > rate`);
          assert.ok(compareRational(hour.rate, hour.highRate) <= 0, `${record.pair.join('|')} rate > high`);
        }
      }
    }
  });

  it('has no rates for a zero-volume market that still has listings', () => {
    const mirror = quoteHour(market(1, CHAOS, MIRROR), CHAOS);
    assert.equal(mirror.rate, null);
    assert.equal(mirror.lowRate, null);
    assert.equal(mirror.baseVolume, 0n);
    assert.ok(mirror.quoteStock.high > 0n, 'chaos is listed against the mirror');

    const essence = quoteHour(market(2, CHAOS, ESSENCE), CHAOS);
    assert.equal(essence.rate, null);
    assert.ok(essence.baseStock.high > 0n && essence.quoteStock.high > 0n, 'both sides listed, no trade');
  });

  it('rejects an item that is not in the pair', () => {
    assert.throws(() => quoteHour(market(0, CHAOS, DIVINE), MIRROR), RangeError);
  });
});

describe('windowRate', () => {
  it('divides total volumes instead of averaging hourly rates', () => {
    const quoted = [0, 1, 2].map((i) => quoteHour(market(i, CHAOS, DIVINE), CHAOS));
    const total = (key: 'quoteVolume' | 'baseVolume') => quoted.reduce((sum, hour) => sum + hour[key], 0n);
    assert.deepEqual(windowRate(quoted), rational(total('quoteVolume'), total('baseVolume')));

    // A 1-unit trade at a wild rate barely moves the weighted rate, unlike a plain average.
    const skewed = [
      { quoteVolume: 3000n, baseVolume: 10n },
      { quoteVolume: 1n, baseVolume: 1n },
    ];
    assert.deepEqual(windowRate(skewed), { num: 3001n, den: 11n });
  });

  it('returns null when nothing traded', () => {
    assert.equal(windowRate([]), null);
    assert.equal(windowRate([quoteHour(market(1, CHAOS, MIRROR), CHAOS)]), null);
  });
});

describe('classifyHour', () => {
  const leagueMarkets = (index: number) => hours[index]?.markets.filter((m) => m.league === 'Mirage').length ?? 0;
  const find = (index: number) => hours[index]?.markets.find((m) => m.pair.includes(HUNGER));

  it('tells traded, listed and inactive hours apart', () => {
    // The Hunger is absent at 10:00 and 11:00 and trades at 12:00.
    assert.equal(classifyHour({ responseMarkets: 1870, leagueMarkets: leagueMarkets(0), market: find(0) }), 'inactive');
    assert.equal(classifyHour({ responseMarkets: 1924, leagueMarkets: leagueMarkets(2), market: find(2) }), 'traded');
    assert.equal(
      classifyHour({ responseMarkets: 1846, leagueMarkets: leagueMarkets(1), market: market(1, CHAOS, MIRROR) }),
      'listed',
    );
  });

  it('treats missing hours and empty responses as unknown, not inactive', () => {
    // 2026-03-06 17:00 UTC, during the Mirage launch, was stored as {"markets": [], "next_change_id": 1772820000}.
    const empty = interpretEnvelope(200, '{"markets": [], "next_change_id": 1772820000}', 1772816400);
    assert.equal(empty.kind === 'hour' && empty.marketCount, 0);
    const down = classifyHour({ responseMarkets: 0, leagueMarkets: 0, market: undefined });
    const missing = classifyHour({ responseMarkets: null, leagueMarkets: 0, market: undefined });
    const noLeague = classifyHour({ responseMarkets: 1870, leagueMarkets: 0, market: undefined });
    assert.deepEqual([down, missing, noLeague], ['exchange-down', 'missing', 'league-absent']);
    assert.ok(![down, missing, noLeague].some(isCovered));
    assert.ok((['inactive', 'listed', 'traded'] as const).every(isCovered));
  });
});

describe('rational', () => {
  it('reduces and refuses zero denominators', () => {
    assert.deepEqual(rational(19350n, 10800n), { num: 43n, den: 24n });
    assert.throws(() => rational(1n, 0n), RangeError);
  });
});
