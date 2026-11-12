import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { createApiServer } from '../src/api/server.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ingest } from '../src/ingest.ts';
import { computeMetrics } from '../src/metrics-run.ts';
import { parsePending } from '../src/parse-hours.ts';
import { CHAOS_PATH, FakeExchange, H0, HOUR, resetSchema, skipWithoutDatabase as skip, TEST_DATABASE_URL } from './support.ts';

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const X = 'Metadata/Items/Scarabs/TestScarab';
const CHEAP = 'Metadata/Items/Currency/RunegraftAttributeGlobalDefences';
const DEAR = 'Metadata/Items/Currency/RunegraftUnexciting';

/** One market as raw JSON with separate volume, lowest and highest ratios for (a, b). */
function market(a: string, b: string, volume: [number, number], low: [number, number], high: [number, number]): string {
  const map = (v: [number, number]) => `{"${a}":${v[0]},"${b}":${v[1]}}`;
  return (
    `{"league":"Mirage","market_id":"${a}|${b}","market_pair":["${a}","${b}"],"volume_traded":${map(volume)},` +
    `"lowest_stock":${map([5, 5])},"highest_stock":${map([5, 5])},"lowest_ratio":${map(low)},"highest_ratio":${map(high)}}`
  );
}

type Json = any;

describe('opportunities (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  let server: http.Server;
  let base: string;

  const get = async (path: string): Promise<{ status: number; body: Json; headers: Headers }> => {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    const text = await response.text();
    const json = response.headers.get('content-type')?.startsWith('application/json') && text ? JSON.parse(text) : text;
    return { status: response.status, body: json, headers: response.headers };
  };

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);

    // Two hours with the same markets, so the 1h window has one previous hour that held.
    const markets = [
      market(CHAOS_PATH, DIVINE, [3000, 10], [300, 1], [300, 1]),
      // X trades for Chaos between two prices, and for Divines.
      market(CHAOS_PATH, X, [300, 10], [25, 1], [35, 1]),
      market(DIVINE, X, [2, 10], [1, 5], [1, 5]),
      // Runegrafts: 10c each (worth too little to count toward EV) and 90c each.
      market(CHAOS_PATH, CHEAP, [300, 30], [10, 1], [10, 1]),
      market(CHAOS_PATH, DEAR, [900, 10], [90, 1], [90, 1]),
    ];
    const exchange = new FakeExchange(2);
    for (const hour of [H0, H0 + HOUR]) {
      exchange.overrides.set(hour, { url: 'fake', status: 200, body: `{"next_change_id":${hour + HOUR},"markets":[${markets.join(',')}]}` });
    }
    await ingest(pool, exchange, { maxHours: 2, start: { kind: 'hour', cursor: H0 } });
    await parsePending(pool, { itemNames: new Map([[X, 'Test Scarab'], [CHEAP, 'Runegraft of the Fortress'], [DEAR, 'Runegraft of Stability']]) });
    await pool.query('UPDATE items SET gold_fee = 10 WHERE metadata_path = ANY($1)', [[X, CHEAP, DEAR, CHAOS_PATH, DIVINE]]);
    await computeMetrics(pool, { quote: 'chaos' });
    await computeMetrics(pool, { quote: 'divine' });

    const runegraftWeights = [
      { name: 'Runegraft of the Fortress', path: CHEAP, probability: 0.5 },
      { name: 'Runegraft of Stability', path: DEAR, probability: 0.5 },
    ];
    server = createApiServer(pool, { runegraftWeights });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('lists flips with the prices of the flipping dashboard', async () => {
    const [{ body }, markets] = await Promise.all([
      get('/api/opportunities?league=Mirage&kinds=flip_chaos&scope=all'),
      get('/api/markets?league=Mirage&scope=all'),
    ]);
    const m = markets.body.data.find((r: Json) => r.item.path === X);
    const o = body.data.find((r: Json) => r.item.path === X);
    assert.equal(o.id, `flip_chaos:${m.id}`);
    assert.deepEqual(
      [o.cost_chaos, o.return_chaos, o.cycles_per_hour, o.gold_per_cycle, o.eligible],
      [m.low_rate.value, m.high_rate.value, m.units_per_hour, m.gold_per_flip, m.eligible],
    );
    assert.ok(o.profit_chaos > 0);
    assert.equal(o.chaos_per_hour_ceiling, o.profit_chaos * o.cycles_per_hour);
  });

  it('lists Chaos → Divine trades with the figures of /api/flips', async () => {
    const [{ body }, flips] = await Promise.all([
      get('/api/opportunities?league=Mirage&kinds=trade_c_d&scope=all'),
      get('/api/flips?league=Mirage&scope=all'),
    ]);
    const f = flips.body.data.find((r: Json) => r.item.path === X);
    const o = body.data.find((r: Json) => r.item.path === X);
    assert.equal(body.meta.divine_rate, 300);
    assert.deepEqual(
      [o.cost_chaos, o.return_chaos, o.profit_chaos, o.margin_share, o.gold_per_cycle, o.eligible],
      [f.buy.value, f.sell_chaos, f.margin_chaos, f.margin_share, f.gold_per_flip, f.eligible],
    );
    assert.equal(o.detail.divine_rate, 300);
  });

  it('lists Runegraft conversions below the EV threshold', async () => {
    const { body } = await get('/api/opportunities?league=Mirage&kinds=runegraft');
    // EV = 0.5 × 90 (the 10c outcome adds nothing) = 45; buy below 45 / 3 × 0.7 = 10.5.
    assert.equal(body.meta.runegraft.ev, 45);
    assert.ok(Math.abs(body.meta.runegraft.recommended - 10.5) < 1e-9);
    assert.equal(body.meta.total, 1);
    const o = body.data[0];
    assert.equal(o.item.path, CHEAP);
    assert.deepEqual([o.cost_chaos, o.return_chaos, o.profit_chaos, o.cycles_per_hour, o.gold_per_cycle, o.basis], [30, 45, 15, 10, 30, 'ev']);
    assert.deepEqual(o.detail.counted.map((c: Json) => c.name), ['Runegraft of Stability']);

    const all = await get('/api/opportunities?league=Mirage&kinds=runegraft&scope=all');
    const dear = all.body.data.find((r: Json) => r.item.path === DEAR);
    assert.equal(dear.eligible, false);
    assert.equal(dear.rank, null);
    assert.match(dear.warnings.join(), /not below the recommended/);
  });

  it('ranks every kind by ceiling, filters, counts and pages', async () => {
    const { body } = await get('/api/opportunities?league=Mirage');
    const ceilings = body.data.map((o: Json) => o.chaos_per_hour_ceiling);
    assert.deepEqual(ceilings, [...ceilings].sort((a: number, b: number) => b - a));
    assert.deepEqual(body.data.map((o: Json) => o.rank), body.data.map((_: Json, i: number) => i + 1));
    assert.ok(body.data.every((o: Json) => o.eligible));
    assert.equal(body.meta.total, Object.values(body.meta.counts).reduce((a: number, b) => a + (b as number), 0));
    assert.match(body.meta.ranking, /upper bound/);

    const runegraftOnly = await get('/api/opportunities?league=Mirage&kinds=runegraft');
    assert.deepEqual(runegraftOnly.body.meta.counts, body.meta.counts, 'counts ignore the kind filter');
    assert.equal((await get('/api/opportunities?league=Mirage&q=fortress')).body.meta.total, 1);
    assert.equal((await get('/api/opportunities?league=Mirage&min_profit=1000')).body.meta.total, 0);
    const paged = await get('/api/opportunities?league=Mirage&limit=1&offset=1');
    assert.deepEqual(paged.body.data.map((o: Json) => o.id), [body.data[1].id]);
    const byName = await get('/api/opportunities?league=Mirage&sort=name');
    assert.equal(byName.body.meta.order, 'asc');
  });

  it('refuses planned kinds and bad parameters', async () => {
    const recipe = await get('/api/opportunities?league=Mirage&kinds=recipe');
    assert.equal(recipe.status, 400);
    assert.equal(recipe.body.error.parameter, 'kinds');
    assert.match(recipe.body.error.message, /not implemented yet/);
    assert.equal((await get('/api/opportunities?league=Mirage&kinds=nope')).status, 400);
    assert.equal((await get('/api/opportunities?league=Mirage&min_profit=abc')).body.error.parameter, 'min_profit');
    assert.equal((await get('/api/opportunities?league=Mirage&sort=rank')).body.error.parameter, 'sort');
    assert.equal((await get('/api/opportunities?league=Nope')).status, 404);
  });

  describe('pages', () => {
    it('serves Opportunities at / and the flipping dashboard at /flipping', async () => {
      const landing = await get('/');
      assert.equal(landing.status, 200);
      assert.match(landing.body, /<script type="module" src="\/opportunities.js"><\/script>/);
      assert.match(landing.body, /Crafting|not live quotes/);
      const flipping = await get('/flipping');
      assert.equal(flipping.status, 200);
      assert.match(flipping.body, /<script type="module" src="\/app.js"><\/script>/);
      assert.equal((await get('/index.html')).status, 404);
      assert.equal((await get('/?league=Mirage&window=24h')).status, 200, 'shared league and window stay on Opportunities');
    });

    it('redirects old dashboard links to /flipping', async () => {
      for (const search of ['?quote=divine', '?league=Mirage&market=abc', '?history=30d', '?offset=50']) {
        const response = await get(`/${search}`);
        assert.equal(response.status, 302, search);
        assert.equal(response.headers.get('location'), `/flipping${search}`);
      }
    });
  });
});
