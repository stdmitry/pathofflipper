import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { collectorStatus } from '../src/api/queries.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { withIngestLock, withPipelineLock } from '../src/ingest.ts';
import { breakEvenBuyPrice, expectedValue, loadWeights, recommendedBuyPrice } from '../src/market/runegraft.ts';
import { runPipelineTick, type TickResult } from '../src/pipeline/index.ts';
import { createJobs } from '../src/pipeline/jobs.ts';
import { runegraftPrices } from '../src/runegraft-prices.ts';
import { CHAOS_PATH, count, FakeExchange, H0, HOUR, marketJson, resetSchema, skipWithoutDatabase as skip, TEST_DATABASE_URL } from './support.ts';

const FORTRESS = 'Metadata/Items/Currency/RunegraftAttributeGlobalDefences';
const STABILITY = 'Metadata/Items/Currency/RunegraftUnexciting';
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';

const statuses = (tick: TickResult | null) => Object.fromEntries((tick?.jobs ?? []).map((j) => [j.job, j.status]));

/** An exchange serving `hours` Mirage hours from H0 with two Runegraft markets and a Divine market. */
function runegraftExchange(hours: number): FakeExchange {
  const exchange = new FakeExchange(hours);
  for (let i = 0; i < hours; i++) {
    const cursor = H0 + i * HOUR;
    const markets = [
      marketJson('Mirage', CHAOS_PATH, STABILITY, ['45', '3']),
      marketJson('Mirage', FORTRESS, CHAOS_PATH, ['2', String(90 + i * 2)]),
      marketJson('Mirage', CHAOS_PATH, DIVINE, ['300', '1']),
    ];
    exchange.overrides.set(cursor, { url: 'fake', status: 200, body: `{"next_change_id":${cursor + HOUR},"markets":[${markets.join(',')}]}` });
  }
  return exchange;
}

describe('pipeline tick (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  const now = () => new Date((H0 + 4 * HOUR + 60) * 1000);

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    await resetSchema(pool);
    await runMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  const jobsFor = (exchange: FakeExchange) =>
    createJobs(pool, { exchange, maxHours: 10, pauseMs: 0, start: { kind: 'hour', cursor: H0 }, itemNames: new Map() });

  it('runs fetch → parse → metrics → runegraft, then does nothing while no new hour arrives', async () => {
    const exchange = runegraftExchange(3);
    const jobs = jobsFor(exchange);

    const first = await runPipelineTick(pool, jobs, { now });
    // The fixture's ratios (e.g. 45:3) are not reduced as the API's are, so the daily check flags them; the other jobs
    // are unaffected.
    assert.deepEqual(statuses(first), { fetch: 'ok', parse: 'ok', metrics: 'ok', runegraft: 'ok', 'check-semantics': 'failed' });
    assert.match(first!.jobs.find((j) => j.job === 'check-semantics')!.reason!, /^invariants violated: ratio_reduced \(\d+\)$/);
    assert.equal(first!.jobs[0]!.details!.hours_stored, 3);
    assert.equal(first!.jobs[0]!.outputWatermark, new Date((H0 + 2 * HOUR) * 1000).toISOString());
    assert.equal(await count(pool, 'job_runs'), 5);

    const second = await runPipelineTick(pool, jobs, { now });
    assert.deepEqual(statuses(second), {
      fetch: 'idle',
      parse: 'up-to-date',
      metrics: 'up-to-date',
      runegraft: 'up-to-date',
      'check-semantics': 'not-due',
    });
    assert.equal(await count(pool, 'job_runs'), 5, 'an idle tick adds no history');

    const { rows } = await pool.query<{ job: string; last_status: string; consecutive_failures: number }>(
      'SELECT job, last_status, consecutive_failures FROM job_state ORDER BY job',
    );
    assert.deepEqual(rows.map((r) => [r.job, r.last_status]), [
      ['check-semantics', 'failed'],
      ['fetch', 'idle'],
      ['metrics', 'ok'],
      ['parse', 'ok'],
      ['runegraft', 'ok'],
    ]);
  });

  it('stores the same EV and recommended price as npm run runegraft computes', async () => {
    const weights = await loadWeights();
    const { prices } = await runegraftPrices(pool, 'Mirage', 24);
    const expected = expectedValue(weights, prices);
    assert.ok(expected.ev !== null);

    const { rows } = await pool.query<{ ev: number; break_even: number; recommended: number; ev_is_estimate: boolean; as_of: Date }>(
      `SELECT r.ev, r.break_even, r.recommended, r.ev_is_estimate, r.as_of_hour AS as_of
       FROM runegraft_runs r JOIN leagues l ON l.id = r.league_id WHERE l.name = 'Mirage' AND r.window_hours = 24`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.as_of.getTime(), (H0 + 2 * HOUR) * 1000);
    assert.equal(rows[0]!.ev, expected.ev);
    assert.equal(rows[0]!.break_even, breakEvenBuyPrice(expected.ev));
    assert.equal(rows[0]!.recommended, recommendedBuyPrice(expected.ev));
    assert.equal(rows[0]!.ev_is_estimate, expected.estimate);

    const items = await pool.query<{ metadata_path: string; buy_price: number; below_recommended: boolean; expected_profit: number }>(
      `SELECT i.metadata_path, ri.buy_price, ri.below_recommended, ri.expected_profit FROM runegraft_run_items ri
       JOIN runegraft_runs r ON r.id = ri.run_id JOIN items i ON i.id = ri.item_id
       WHERE r.window_hours = 24 ORDER BY i.metadata_path`,
    );
    assert.deepEqual(
      items.rows.map((r) => [r.metadata_path, r.buy_price, r.below_recommended]),
      prices.map((p) => [p.path, p.buyPriceChaos, p.buyPriceChaos < recommendedBuyPrice(expected.ev!)]),
    );
    assert.equal(items.rows[0]!.expected_profit, expected.ev - 3 * prices[0]!.buyPriceChaos);
  });

  it('runs again for a new hour and keeps the earlier Runegraft runs', async () => {
    const tick = await runPipelineTick(pool, jobsFor(runegraftExchange(4)), { now });
    assert.deepEqual(statuses(tick), { fetch: 'ok', parse: 'ok', metrics: 'ok', runegraft: 'ok', 'check-semantics': 'not-due' });
    const { rows } = await pool.query<{ hours: number }>('SELECT count(DISTINCT as_of_hour)::int AS hours FROM runegraft_runs');
    assert.equal(rows[0]!.hours, 2);
  });

  it('replaces the runs of an hour when it is computed again', async () => {
    const before = await count(pool, 'runegraft_runs');
    const tick = await runPipelineTick(pool, jobsFor(runegraftExchange(4)), { only: ['metrics', 'runegraft'], force: true, now });
    assert.deepEqual(statuses(tick), { metrics: 'ok', runegraft: 'ok' });
    assert.equal(await count(pool, 'runegraft_runs'), before);
  });

  it('skips a tick while another holds the pipeline lock, and marks a job busy while its stage lock is held', async () => {
    const jobs = jobsFor(runegraftExchange(4));
    assert.equal(await withPipelineLock(pool, () => runPipelineTick(pool, jobs, { now })), null);

    const tick = await withIngestLock(pool, () => runPipelineTick(pool, jobs, { only: ['fetch'], now }));
    assert.deepEqual(statuses(tick), { fetch: 'busy' });
    const { rows } = await pool.query<{ status: string; error: string }>(
      `SELECT status, error FROM job_runs WHERE job = 'fetch' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0]!.status, 'busy');
    assert.match(rows[0]!.error, /already running/);
  });

  it('reports each job in /api/status, and a job failing 3 ticks in a row as a problem', async () => {
    const status = await collectorStatus(pool, now());
    assert.deepEqual(
      status.data.jobs.map((j) => [j.job, j.failing]),
      [
        ['check-semantics', false],
        ['fetch', false],
        ['metrics', false],
        ['parse', false],
        ['runegraft', false],
      ],
    );
    assert.ok(!status.data.problems.includes('jobs_failing'));

    const broken = jobsFor(runegraftExchange(4)).map((job) =>
      job.name === 'runegraft' ? { ...job, run: () => Promise.reject(new Error('weights unreadable')) } : job,
    );
    for (let i = 0; i < 3; i++) await runPipelineTick(pool, broken, { only: ['runegraft'], force: true, now });
    const degraded = await collectorStatus(pool, now());
    const runegraft = degraded.data.jobs.find((j) => j.job === 'runegraft')!;
    assert.equal(runegraft.consecutive_failures, 3);
    assert.equal(runegraft.last_error, 'weights unreadable');
    assert.ok(degraded.data.problems.includes('jobs_failing'));
  });
});
