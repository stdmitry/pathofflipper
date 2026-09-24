import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { compact, historySeries, marketRow, rateText } from '../public/view.js';
import { encodeMarketId } from '../src/api/params.ts';
import { createApiServer } from '../src/api/server.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { computeMetrics } from '../src/metrics-run.ts';
import {
  CHAOS_PATH,
  H0,
  HOUR,
  loadMirageHours,
  mirageFixture,
  resetSchema,
  skipWithoutDatabase as skip,
  TEST_DATABASE_URL,
} from './support.ts';

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const CHROMATIC = 'Metadata/Items/Currency/CurrencyRerollSocketColours';

type RawMarket = { league: string; market_pair: string[] } & Record<string, Record<string, number>>;

/** Chaos/`item` in fixture hour `index`, straight from the stored response. */
function raw(index: number, item: string): RawMarket {
  const markets = mirageFixture.hours[index]!.body.markets as RawMarket[];
  const found = markets.find((m) => m.market_pair.includes(CHAOS_PATH) && m.market_pair.includes(item));
  assert.ok(found);
  return found;
}

/** A rate object for view.js from a chaos amount and an item amount. */
const chaosPer = (chaos: number, units: number) => ({ num: String(chaos), den: String(units), value: chaos / units });

// Displayed values are checked against numbers computed here from the raw fixture, independently of the API code.
describe('dashboard against the Mirage fixture (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  let server: http.Server;
  let base: string;

  const getJson = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);
    await loadMirageHours(pool);
    await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR });
    server = createApiServer(pool);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  it('shows the Chaos/Divine row as the fixture hour says (Chaos is item a)', async () => {
    const body = await getJson('/api/markets?league=Mirage&window=1h');
    const row = marketRow(body.data.find((m: any) => m.item.path === DIVINE));
    const m = raw(2, DIVINE);
    const chaos = m.volume_traded![CHAOS_PATH]!;
    const divine = m.volume_traded![DIVINE]!;
    // Upstream ratios are chaos : divine, since Chaos is market_pair[0].
    const low = chaosPer(m.lowest_ratio![CHAOS_PATH]!, m.lowest_ratio![DIVINE]!);
    const high = chaosPer(m.highest_ratio![CHAOS_PATH]!, m.highest_ratio![DIVINE]!);
    assert.equal(row.low, rateText(low));
    assert.equal(row.high, rateText(high));
    assert.deepEqual([row.low, row.high], [`${(low.value).toFixed(1)}c`, `${(high.value).toFixed(1)}c`]);
    assert.equal(row.turnover, `${compact(chaos)}c/h`);
    assert.equal(row.units, `${compact(divine)}/h`);
    assert.deepEqual([row.rank, row.traded, row.coverage], ['1', '1/1 h', '100%']);
  });

  it('shows Chromatic/Chaos per chaos (Chaos is item b)', async () => {
    const body = await getJson('/api/markets?league=Mirage&window=1h');
    const row = marketRow(body.data.find((m: any) => m.item.path === CHROMATIC));
    const m = raw(2, CHROMATIC);
    const chaos = m.volume_traded![CHAOS_PATH]!;
    const chromatic = m.volume_traded![CHROMATIC]!;
    assert.ok(chaos < chromatic, 'a chromatic is worth less than a chaos');
    // Ratios are chromatic : chaos here, so the lowest chaos price comes from the highest ratio (18 chromatic : 1 chaos)
    // and the highest from the lowest ratio (1 : 1, i.e. exactly 1 chaos each, which reads in chaos).
    assert.deepEqual([m.highest_ratio![CHROMATIC], m.highest_ratio![CHAOS_PATH], m.lowest_ratio![CHROMATIC], m.lowest_ratio![CHAOS_PATH]], [18, 1, 1, 1]);
    assert.equal(row.low, '18.0 per c');
    assert.equal(row.high, '1.0c');
    assert.equal(row.turnover, `${compact(chaos)}c/h`);
    assert.equal(row.units, `${compact(chromatic)}/h`);
  });

  it('charts each traded hour at its fixture low and high and leaves other hours empty', async () => {
    const history = await getJson(`/api/markets/${encodeMarketId(DIVINE)}/history?league=Mirage`);
    const series = historySeries(history.data);
    // The window ends at H0+3h (the exchange-down hour); the fixture hours are the three before it.
    const ratio = (i: number, field: string) => raw(i, DIVINE)[field]![CHAOS_PATH]! / raw(i, DIVINE)[field]![DIVINE]!;
    assert.deepEqual(series.low.slice(-4, -1), [0, 1, 2].map((i) => ratio(i, 'lowest_ratio')));
    assert.deepEqual(series.high.slice(-4, -1), [0, 1, 2].map((i) => ratio(i, 'highest_ratio')));
    assert.deepEqual(series.turnover.slice(-4, -1), [0, 1, 2].map((i) => raw(i, DIVINE).volume_traded![CHAOS_PATH]!));
    assert.deepEqual([series.low.at(-1), series.high.at(-1)], [null, null]);
    assert.equal(series.turnover.at(-1), null, 'the exchange-down hour is unknown, not zero');
    assert.ok(series.high.slice(0, -4).every((v) => v === null));
  });

  describe('static files', () => {
    it('serves the page with a strict content security policy', async () => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /^text\/html/);
      assert.match(response.headers.get('content-security-policy')!, /script-src 'self'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const html = await response.text();
      assert.match(html, /<script type="module" src="\/app.js"><\/script>/);
      assert.match(html, /not live quotes/);
    });

    it('serves scripts and caches the versioned vendor library', async () => {
      const app = await fetch(`${base}/app.js`);
      assert.match(app.headers.get('content-type')!, /^text\/javascript/);
      assert.equal(app.headers.get('cache-control'), 'no-cache');
      const vendor = await fetch(`${base}/vendor/uplot-1.6.32/uPlot.iife.min.js`);
      assert.equal(vendor.status, 200);
      assert.match(vendor.headers.get('cache-control')!, /immutable/);
    });

    it('serves nothing outside the public directory or of another type', async () => {
      for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/tsconfig.json', '/vendor/uplot-1.6.32/LICENSE', '/nope.js', '/%E0%A4%A']) {
        assert.equal((await fetch(`${base}${path}`)).status, 404, path);
      }
      const api = await fetch(`${base}/api/nope`);
      assert.equal(api.status, 404);
      assert.equal(((await api.json()) as any).error.code, 'not_found');
    });
  });
});
