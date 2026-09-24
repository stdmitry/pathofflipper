import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { encodeMarketId } from '../src/api/params.ts';
import { CALC_VERSION } from '../src/market/metrics.ts';
import { createApiServer } from '../src/api/server.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { ingest } from '../src/ingest.ts';
import { computeMetrics } from '../src/metrics-run.ts';
import { parsePending } from '../src/parse-hours.ts';
import {
  FakeExchange,
  H0,
  HOUR,
  loadMirageHours,
  resetSchema,
  skipWithoutDatabase as skip,
  TEST_DATABASE_URL,
} from './support.ts';

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const MIRROR = 'Metadata/Items/Currency/CurrencyDuplicate';
const NON_CHAOS = 'Metadata/Items/Currency/Mushrune5';
/** The newest loaded hour is the exchange-down hour H0+3h, complete at H0+4h; the clock is 90 minutes later. */
const NOW = new Date((H0 + 4 * HOUR + 90 * 60) * 1000);

// Response bodies are loosely typed on purpose: the tests check the JSON contract clients see.
type Json = any;

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('read API (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  let server: http.Server;
  let base: string;

  async function get(path: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: Json }> {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);
    server = createApiServer(pool, { now: () => NOW });
    base = await listen(server);
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE metric_runs, market_metrics, league_hours, pair_hours, pairs, items, leagues, raw_digests,
         ingestion_cursors, rejected_responses RESTART IDENTITY CASCADE`,
    );
  });

  describe('before any data', () => {
    it('lists no leagues and reports the status as degraded', async () => {
      const leagues = await get('/api/leagues');
      assert.equal(leagues.status, 200);
      assert.deepEqual(leagues.body.data, []);
      assert.deepEqual([leagues.body.meta.as_of_hour, leagues.body.meta.stale], [null, true]);

      const status = await get('/api/status');
      assert.equal(status.body.data.state, 'degraded');
      assert.deepEqual(status.body.data.problems, ['no_data', 'metrics_behind']);
    });

    it('answers 404 for an unknown league', async () => {
      const response = await get('/api/markets?league=Mirage');
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'not_found');
    });
  });

  describe('with the Mirage hours and metrics as of H0+2h', () => {
    beforeEach(async () => {
      await loadMirageHours(pool);
      await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR });
    });

    it('lists leagues of the snapshot', async () => {
      const { body } = await get('/api/leagues');
      assert.deepEqual(body.data, [{ name: 'Mirage', active: true, markets_24h: 5, eligible_markets_24h: 0 }]);
      assert.equal(body.meta.as_of_hour, new Date((H0 + 2 * HOUR) * 1000).toISOString());
      assert.equal(body.meta.calc_version, CALC_VERSION);
    });

    it('lists eligible markets by rank with units, freshness and the activity label', async () => {
      const { status, body } = await get('/api/markets?league=Mirage&window=1h');
      assert.equal(status, 200);
      assert.deepEqual(body.data.map((m: Json) => [m.item.path, m.rank]), [
        [DIVINE, 1],
        ['Metadata/Items/Currency/CurrencyRerollSocketColours', 2],
      ]);
      const divine = body.data[0];
      assert.equal(divine.id, encodeMarketId(DIVINE));
      // Only Chaos Orb has a name in this test, so the others fall back to their path.
      assert.deepEqual(divine.item, { name: 'CurrencyModValues', path: DIVINE, category: 'Currency', named: false });
      assert.deepEqual([divine.covered_hours, divine.coverage, divine.persistence], [1, 1, 1]);
      assert.ok(divine.rate.value > 300 && divine.rate.value < 400, `chaos per divine, got ${divine.rate.value}`);
      assert.equal(typeof divine.volume.quote, 'string', 'integer totals are exact strings');
      assert.equal(body.meta.total, 2);
      assert.match(body.meta.ranking, /not a validated profit estimate/);
      // Rank 1 has the higher score: (high − low) / low × Chaos per hour.
      assert.ok(body.data[0].score > body.data[1].score);
      const d = body.data[0];
      assert.ok(Math.abs(d.score - ((d.high_rate.value - d.low_rate.value) / d.low_rate.value) * d.turnover_per_hour) < 1e-6);
      assert.ok(body.meta.units.rate);
      // H0+2h ended at H0+3h; the clock is 2.5 hours later, within the 3-hour limit.
      assert.deepEqual([body.meta.source_age_hours, body.meta.stale], [2.5, false]);
    });

    it('lists every market with scope=all, sorts, searches and pages', async () => {
      const all = await get('/api/markets?league=Mirage&scope=all&sort=turnover');
      assert.equal(all.body.meta.total, 5);
      assert.equal(all.body.data[0].item.path, DIVINE);
      assert.ok(all.body.data.every((m: Json) => m.rank === null), 'no 24h market has enough coverage');
      assert.equal(all.body.data.at(-1).turnover_per_hour, 0, 'listed-only markets trade nothing');

      const page = await get('/api/markets?league=Mirage&scope=all&sort=turnover&limit=2&offset=1');
      assert.deepEqual(page.body.data.map((m: Json) => m.item.path), all.body.data.slice(1, 3).map((m: Json) => m.item.path));
      assert.equal(page.body.meta.total, 5);

      // Low and high sort by the traded price extremes; markets without trades go last either way.
      for (const key of ['low', 'high']) {
        const sorted = await get(`/api/markets?league=Mirage&scope=all&sort=${key}`);
        const values = sorted.body.data.map((m: Json) => m[`${key}_rate`]?.value ?? null);
        const priced = values.filter((v: number | null) => v !== null);
        assert.deepEqual(priced, [...priced].sort((a: number, b: number) => b - a), `sort=${key} is descending`);
        assert.deepEqual(values.slice(priced.length), values.slice(priced.length).map(() => null));
      }

      // Range sorts by high minus low in Chaos.
      const ranged = await get('/api/markets?league=Mirage&scope=all&sort=range');
      const widths = ranged.body.data
        .filter((m: Json) => m.high_rate)
        .map((m: Json) => m.high_rate.value - m.low_rate.value);
      assert.deepEqual(widths, [...widths].sort((a: number, b: number) => b - a));

      const mirror = await get('/api/markets?league=Mirage&scope=all&q=duplicate');
      assert.deepEqual(mirror.body.data.map((m: Json) => m.item.path), [MIRROR]);
      const wildcard = await get(`/api/markets?league=Mirage&scope=all&q=${encodeURIComponent('%')}`);
      assert.equal(wildcard.body.meta.total, 0, '% is matched literally');
    });

    it('serves Divine-quoted markets and their history', async () => {
      await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR, quote: 'divine' });
      const { body } = await get('/api/markets?league=Mirage&quote=divine&window=1h');
      assert.equal(body.meta.quote, 'divine');
      assert.deepEqual(body.data.map((m: Json) => [m.item.name, m.rank]), [['Chaos Orb', 1]]);
      assert.ok(body.data[0].low_rate.value < 0.01, 'a Chaos Orb is worth a fraction of a Divine');

      const chaosId = encodeMarketId('Metadata/Items/Currency/CurrencyRerollRare');
      const history = await get(`/api/markets/${chaosId}/history?league=Mirage&quote=divine`);
      assert.equal(history.status, 200);
      assert.equal(history.body.data.summary.traded_hours, 3);
      // Divine has no Divine market, so its id does not resolve when quoted in Divine.
      assert.equal((await get(`/api/markets/${encodeMarketId(DIVINE)}/history?league=Mirage&quote=divine`)).status, 404);
    });

    it('returns one point per hour with explicit gaps', async () => {
      const { status, body } = await get(`/api/markets/${encodeMarketId(DIVINE)}/history?league=Mirage`);
      assert.equal(status, 200);
      const hours = body.data.hours as Json[];
      assert.equal(hours.length, 24);
      assert.equal(hours.at(-1).hour, new Date((H0 + 3 * HOUR) * 1000).toISOString());
      const counts: Record<string, number> = {};
      for (const h of hours) counts[h.status] = (counts[h.status] ?? 0) + 1;
      assert.deepEqual(counts, { missing: 20, traded: 3, 'exchange-down': 1 });
      assert.deepEqual(hours.at(-1), {
        hour: hours.at(-1).hour,
        status: 'exchange-down',
        volume: null,
        rate: null,
        low_rate: null,
        high_rate: null,
        stock: null,
      });
      const traded = hours.find((h) => h.status === 'traded');
      assert.ok(traded.stock.quote.high && traded.low_rate.value <= traded.rate.value);
      assert.deepEqual([body.data.summary.covered_hours, body.data.summary.coverage], [3, 3 / 24]);
      assert.ok(body.meta.statuses.missing);

      const week = await get(`/api/markets/${encodeMarketId(DIVINE)}/history?league=Mirage&window=7d`);
      assert.equal(week.body.data.hours.length, 168);
    });

    it('tells inactive and listed hours apart in history', async () => {
      const { body } = await get(`/api/markets/${encodeMarketId(MIRROR)}/history?league=Mirage`);
      assert.deepEqual(body.data.hours.slice(-4).map((h: Json) => h.status), ['inactive', 'listed', 'inactive', 'exchange-down']);
    });

    it('does not serve private leagues', async () => {
      await pool.query(`INSERT INTO leagues (realm, name) VALUES ('pc', 'Limey Whelps (PL86569)')`);
      const league = encodeURIComponent('Limey Whelps (PL86569)');
      for (const path of [`/api/markets?league=${league}`, `/api/markets/${encodeMarketId(DIVINE)}/history?league=${league}`]) {
        const { status, body } = await get(path);
        assert.equal(status, 404, path);
        assert.match(body.error.message, /private/);
      }
    });

    it('answers 404 for unknown or non-Chaos markets', async () => {
      for (const id of ['xyz', encodeMarketId('Metadata/Items/Currency/NotStored'), encodeMarketId(NON_CHAOS)]) {
        const response = await get(`/api/markets/${id}/history?league=Mirage`);
        assert.equal(response.status, 404, id);
      }
    });

    it('reports collection state', async () => {
      const { body } = await get('/api/status');
      assert.equal(body.data.state, 'degraded');
      assert.deepEqual(body.data.problems, ['metrics_behind', 'gaps_last_24h']);
      assert.equal(body.data.collection.newest_parsed_hour, new Date((H0 + 3 * HOUR) * 1000).toISOString());
      assert.deepEqual([body.data.collection.pending_parse, body.data.collection.parsed_hours_last_24h], [0, 4]);
      assert.equal(body.data.source.stale, false);

      await computeMetrics(pool);
      const after = await get('/api/status');
      assert.deepEqual(after.body.data.problems, ['gaps_last_24h']);
    });

    it('answers 304 to a matching ETag and drops cached responses when new data is committed', async () => {
      const first = await get('/api/markets?league=Mirage&window=1h');
      const etag = first.headers.get('etag')!;
      assert.ok(etag);
      assert.equal((await get('/api/markets?window=1h&league=Mirage', { headers: { 'If-None-Match': etag } })).status, 304);

      // A new metrics run: the next response reflects it.
      await computeMetrics(pool, { asOfHour: H0 + HOUR });
      const rerun = await get('/api/markets?league=Mirage&window=1h', { headers: { 'If-None-Match': etag } });
      assert.equal(rerun.status, 200);
      assert.equal(rerun.body.meta.as_of_hour, new Date((H0 + HOUR) * 1000).toISOString());

      // A newly parsed hour: history ends with it. Its response has no Mirage markets, so the league is absent.
      const path = `/api/markets/${encodeMarketId(DIVINE)}/history?league=Mirage`;
      assert.equal((await get(path)).body.data.hours.at(-1).status, 'exchange-down');
      await ingest(pool, new FakeExchange(5), { maxHours: 1, start: { kind: 'hour', cursor: H0 } });
      await parsePending(pool, { itemNames: new Map() });
      const history = await get(path);
      assert.equal(history.body.data.hours.at(-1).hour, new Date((H0 + 4 * HOUR) * 1000).toISOString());
      assert.equal(history.body.data.hours.at(-1).status, 'league-absent');
    });
  });

  describe('request errors', () => {
    it('answers 400 naming the parameter', async () => {
      const cases: [string, string][] = [
        ['/api/markets?league=M&window=2h', 'window'],
        ['/api/markets?leauge=M', 'leauge'],
        ['/api/markets?league=M&league=N', 'league'],
        ['/api/markets?league=M&limit=1000', 'limit'],
        ['/api/leagues?realm=xbox', 'realm'],
        ['/api/status?verbose=1', 'verbose'],
      ];
      for (const [path, parameter] of cases) {
        const { status, body } = await get(path);
        assert.equal(status, 400, path);
        assert.deepEqual([body.error.code, body.error.parameter], ['invalid_parameter', parameter], path);
      }
    });

    it('answers 404 for unknown paths and 405 for other methods', async () => {
      assert.equal((await get('/api/nothing')).status, 404);
      assert.equal((await fetch(`${base}/`)).status, 200, '/ is the dashboard');
      const post = await get('/api/status', { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
    });

    it('answers HEAD without a body', async () => {
      const head = await fetch(`${base}/api/leagues`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    });

    it('answers 503 when the database is unreachable', async () => {
      const deadPool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 1000 });
      const dead = createApiServer(deadPool);
      const url = await listen(dead);
      try {
        const response = await fetch(`${url}/api/status`);
        assert.equal(response.status, 503);
        assert.equal(((await response.json()) as Json).error.code, 'unavailable');
      } finally {
        await new Promise((resolve) => dead.close(resolve));
        await deadPool.end();
      }
    });
  });
});
