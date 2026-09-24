import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.ts';
import { ConcurrentRunError, ingest, withMetricsLock } from '../src/ingest.ts';
import { parsePending } from '../src/parse-hours.ts';
import { CALC_VERSION } from '../src/market/metrics.ts';
import { CHAOS_PATH, computeMetrics } from '../src/metrics-run.ts';
import {
  FakeExchange,
  H0,
  HOUR,
  loadMirageHours,
  marketJson,
  mirageFixture,
  resetSchema,
  skipWithoutDatabase as skip,
  TEST_DATABASE_URL,
} from './support.ts';

// The Mirage fixture hours are served as H0 .. H0+2h, then an exchange-down hour (see loadMirageHours).
const mirage = mirageFixture;

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const CHROMATIC = 'Metadata/Items/Currency/CurrencyRerollSocketColours';
const MIRROR = 'Metadata/Items/Currency/CurrencyDuplicate';
/** Chaos markets in the fixture: Divine, Chromatic, The Hunger, an Essence and the Mirror. */
const CHAOS_MARKETS = 5;

interface MetricRow {
  window_hours: number;
  covered_hours: number;
  traded_hours: number;
  quote_volume: string;
  base_volume: string;
  rate_num: string | null;
  rate_den: string | null;
  quote_per_hour: string | null;
  activity_rank: number | null;
}

describe('computeMetrics (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;

  async function metricsFor(item: string): Promise<Map<number, MetricRow>> {
    const { rows } = await pool.query<MetricRow>(
      `SELECT m.window_hours, m.covered_hours, m.traded_hours, m.quote_volume, m.base_volume, m.rate_num, m.rate_den,
         m.quote_per_hour, m.activity_rank
       FROM market_metrics m JOIN pairs p ON p.id = m.pair_id
       JOIN items i ON i.id IN (p.item_a_id, p.item_b_id) AND i.metadata_path = $1`,
      [item],
    );
    return new Map(rows.map((row) => [row.window_hours, row]));
  }

  /** Stored volume_traded of Chaos/`item` for each fixture hour, as [chaos, other]. */
  function volumes(item: string): [bigint, bigint][] {
    return mirage.hours.map(({ body }) => {
      const market = (body.markets as { market_pair: string[]; volume_traded: Record<string, number> }[]).find(
        (m) => m.market_pair.includes(CHAOS_PATH) && m.market_pair.includes(item),
      );
      return market ? [BigInt(market.volume_traded[CHAOS_PATH]!), BigInt(market.volume_traded[item]!)] : [0n, 0n];
    });
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE metric_runs, market_metrics, pair_hours, pairs, items, leagues, raw_digests, ingestion_cursors,
         rejected_responses RESTART IDENTITY CASCADE`,
    );
  });

  it('does nothing before any hour is parsed', async () => {
    const summary = await computeMetrics(pool);
    assert.equal(summary.asOfHour, null);
    assert.equal((await pool.query('SELECT 1 FROM metric_runs')).rowCount, 0);
  });

  it('ends the windows at the newest parsed hour and keeps unknown hours out of coverage', async () => {
    await loadMirageHours(pool);
    const summary = await computeMetrics(pool);
    assert.equal(summary.asOfHour, H0 + 3 * HOUR);
    assert.deepEqual(summary.windowHours, { parsed: 3, empty: 1, missing: 20 });
    assert.deepEqual([summary.leagues, summary.markets, summary.rows], [1, CHAOS_MARKETS, CHAOS_MARKETS * 3]);

    const divine = await metricsFor(DIVINE);
    // 1h: only the exchange-down hour, so nothing is covered and turnover is unknown rather than zero.
    assert.deepEqual([divine.get(1)?.covered_hours, divine.get(1)?.quote_per_hour, divine.get(1)?.rate_num], [0, null, null]);
    // 6h and 24h: the three Mirage hours are covered; the rest is missing or down.
    const v = volumes(DIVINE);
    const chaos = v.reduce((sum, [c]) => sum + c, 0n);
    const div = v.reduce((sum, [, d]) => sum + d, 0n);
    for (const window of [6, 24]) {
      const row = divine.get(window)!;
      assert.deepEqual([row.covered_hours, row.traded_hours], [3, 3]);
      assert.deepEqual([BigInt(row.quote_volume), BigInt(row.base_volume)], [chaos, div]);
      assert.equal(BigInt(row.rate_num!) * div, chaos * BigInt(row.rate_den!), 'rate is chaos per divine');
      assert.equal(Number(row.quote_per_hour), Number(chaos) / 3);
      assert.equal(row.activity_rank, null, '3 of 6 covered hours is below the coverage threshold');
    }
  });

  it('ranks eligible markets when the window is covered', async () => {
    await loadMirageHours(pool);
    await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR });
    assert.equal((await metricsFor(DIVINE)).get(1)?.activity_rank, 1);
    assert.equal((await metricsFor(CHROMATIC)).get(1)?.activity_rank, 2);

    // The Mirror is absent at H0+2h while Mirage is present: covered, inactive, unranked.
    const mirror = (await metricsFor(MIRROR)).get(1)!;
    assert.deepEqual([mirror.covered_hours, mirror.traded_hours, mirror.activity_rank], [1, 0, null]);
    const ranked = await pool.query('SELECT 1 FROM market_metrics WHERE window_hours = 1 AND activity_rank IS NOT NULL');
    assert.equal(ranked.rowCount, 2, 'The Hunger trades under 100 chaos/hour; the Essence only has listings');
  });

  it('replaces the snapshot of the calculation version', async () => {
    await loadMirageHours(pool);
    await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR });
    await computeMetrics(pool);
    const { rows } = await pool.query<{ as_of: string; calc_version: number }>(
      'SELECT extract(epoch FROM as_of_hour)::bigint AS as_of, calc_version FROM metric_runs',
    );
    assert.deepEqual(rows, [{ as_of: String(H0 + 3 * HOUR), calc_version: CALC_VERSION }]);
    assert.equal((await pool.query('SELECT 1 FROM market_metrics')).rowCount, CHAOS_MARKETS * 3);
  });

  it('uses parsed hours only', async () => {
    await loadMirageHours(pool);
    // A newer fetched hour that has not been parsed yet does not move the windows.
    await ingest(pool, new FakeExchange(5), { maxHours: 1, start: { kind: 'hour', cursor: H0 } });
    assert.equal((await pool.query('SELECT 1 FROM raw_digests WHERE parser_version IS NULL')).rowCount, 1);
    assert.equal((await computeMetrics(pool)).asOfHour, H0 + 3 * HOUR);
  });

  it('refuses to run concurrently', async () => {
    await loadMirageHours(pool);
    await withMetricsLock(pool, async () => {
      await assert.rejects(computeMetrics(pool), ConcurrentRunError);
    });
  });

  it('computes Divine-quoted markets as a separate snapshot', async () => {
    await loadMirageHours(pool);
    await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR });
    const divine = await computeMetrics(pool, { asOfHour: H0 + 2 * HOUR, quote: 'divine' });
    // In the trimmed fixture only Chaos Orb trades against Divine, so it is the one Divine-quoted market.
    assert.deepEqual([divine.leagues, divine.markets, divine.rows], [1, 1, 3]);
    const runs = await pool.query<{ path: string }>(
      'SELECT i.metadata_path AS path FROM metric_runs r JOIN items i ON i.id = r.quote_item_id ORDER BY r.id',
    );
    assert.deepEqual(runs.rows.map((r) => r.path), [CHAOS_PATH, DIVINE]);

    const { rows } = await pool.query<MetricRow>(
      `SELECT m.window_hours, m.quote_volume, m.base_volume, m.rate_num, m.rate_den, m.activity_rank
       FROM market_metrics m JOIN metric_runs r ON r.id = m.run_id JOIN items q ON q.id = r.quote_item_id
       WHERE q.metadata_path = $1 AND m.window_hours = 1`,
      [DIVINE],
    );
    const [chaos, div] = volumes(DIVINE)[2]!;
    // Quoted in Divine: Divine is the quote side, Chaos the base.
    assert.deepEqual([BigInt(rows[0]!.quote_volume), BigInt(rows[0]!.base_volume)], [div, chaos]);
    assert.equal(BigInt(rows[0]!.rate_num!) * chaos, div * BigInt(rows[0]!.rate_den!), 'divine per chaos');
    assert.equal(rows[0]!.activity_rank, 1, 'tens of thousands of Divines an hour clear the 0.3 div/h minimum');
  });

  it('skips private leagues', async () => {
    await loadMirageHours(pool);
    // One more hour with the same Chaos/Divine market in Mirage and in a private league.
    const hour = H0 + 4 * HOUR;
    const markets = ['Mirage', 'Limey Whelps (PL86569)'].map((league) => marketJson(league, CHAOS_PATH, DIVINE, ['300', '1']));
    const exchange = new FakeExchange(5);
    exchange.overrides.set(hour, { url: 'fake', status: 200, body: `{"next_change_id":${hour + HOUR},"markets":[${markets.join(',')}]}` });
    await ingest(pool, exchange, { maxHours: 1, start: { kind: 'hour', cursor: H0 } });
    await parsePending(pool, { itemNames: new Map() });

    const summary = await computeMetrics(pool);
    assert.equal(summary.asOfHour, hour);
    assert.equal(summary.leagues, 1);
    const { rows } = await pool.query<{ name: string }>(
      'SELECT DISTINCT l.name FROM market_metrics m JOIN leagues l ON l.id = m.league_id',
    );
    assert.deepEqual(rows, [{ name: 'Mirage' }]);
  });

  it('marks private leagues by their (PL<number>) suffix', async () => {
    const names = ['Allflame', 'Phrecia 2.0', 'HC Ruthless Allflame', 'Limey Whelps (PL86569)', 'Odd (PL)', 'X (PL1) y'];
    await pool.query(`INSERT INTO leagues (realm, name) SELECT 'pc', unnest($1::text[])`, [names]);
    const { rows } = await pool.query<{ name: string; private: boolean }>('SELECT name, private FROM leagues ORDER BY id');
    assert.deepEqual(
      rows.map((r) => [r.name, r.private]),
      names.map((name) => [name, name === 'Limey Whelps (PL86569)']),
    );
  });

  it('categorizes items by their Metadata path', async () => {
    await loadMirageHours(pool);
    const { rows } = await pool.query<{ category: string }>('SELECT category FROM items WHERE metadata_path = $1', [
      CHAOS_PATH,
    ]);
    assert.equal(rows[0]?.category, 'Currency');
  });
});
