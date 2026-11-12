import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConcurrentRunError } from '../src/ingest.ts';
import { type Job, type JobOutcome, orderJobs } from '../src/pipeline/job.ts';
import { dailyAfterMidnightUtc } from '../src/pipeline/jobs.ts';
import { MemoryStateStore, runTick, tickFailed, type TickResult } from '../src/pipeline/runner.ts';
import { nextTickDelay } from '../src/pipeline/schedule.ts';

/** A job whose input is a mutable value and whose run is scripted; counts its runs. */
function fakeJob(name: string, dependsOn: string[] = [], overrides: Partial<Job> = {}) {
  const job = {
    input: 'h1' as string | null,
    runs: 0,
    outcome: (): JobOutcome | Promise<JobOutcome> => ({ outputWatermark: `${name}-out`, details: {} }),
  };
  const definition: Job = {
    name,
    dependsOn,
    timeoutMs: 1000,
    inputWatermark: async () => job.input,
    run: async () => {
      job.runs++;
      return job.outcome();
    },
    ...overrides,
  };
  return Object.assign(job, { definition });
}

const statuses = (tick: TickResult) => Object.fromEntries(tick.jobs.map((j) => [j.job, j.status]));

describe('orderJobs', () => {
  const job = (name: string, dependsOn: string[] = []): Job => ({ name, dependsOn, timeoutMs: 1, run: async () => ({ outputWatermark: null, details: {} }) });

  it('puts every job after its dependencies and keeps the given order otherwise', () => {
    const ordered = orderJobs([job('runegraft', ['metrics']), job('fetch'), job('metrics', ['parse']), job('parse', ['fetch']), job('check', ['parse'])]);
    assert.deepEqual(ordered.map((j) => j.name), ['fetch', 'parse', 'metrics', 'runegraft', 'check']);
  });

  it('rejects unknown dependencies, duplicates and cycles', () => {
    assert.throws(() => orderJobs([job('a', ['nope'])]), /depends on unknown job nope/);
    assert.throws(() => orderJobs([job('a'), job('a')]), /duplicate job a/);
    assert.throws(() => orderJobs([job('a', ['b']), job('b', ['a'])]), /cycle: a → b → a/);
  });
});

describe('runTick', () => {
  it('runs a job when its input changed and skips it when it did not', async () => {
    const parse = fakeJob('parse');
    const metrics = fakeJob('metrics', ['parse']);
    const store = new MemoryStateStore();
    const jobs = [metrics.definition, parse.definition];

    assert.deepEqual(statuses(await runTick(jobs, store)), { parse: 'ok', metrics: 'ok' });
    assert.deepEqual(statuses(await runTick(jobs, store)), { parse: 'up-to-date', metrics: 'up-to-date' });
    metrics.input = 'h2';
    assert.deepEqual(statuses(await runTick(jobs, store)), { parse: 'up-to-date', metrics: 'ok' });
    assert.equal(parse.runs, 1);
    assert.equal(metrics.runs, 2);
    assert.equal(store.runs.length, 3, 'skipped jobs are not recorded');
    assert.equal(store.states.get('metrics')?.inputWatermark, 'h2');
  });

  it('waits while a job has no input yet', async () => {
    const runegraft = fakeJob('runegraft');
    runegraft.input = null;
    assert.deepEqual(statuses(await runTick([runegraft.definition], new MemoryStateStore())), { runegraft: 'waiting' });
    assert.equal(runegraft.runs, 0);
  });

  it('keeps going after a failure, and retries the failed job on unchanged input', async () => {
    const fetch = fakeJob('fetch');
    const parse = fakeJob('parse', ['fetch']);
    fetch.outcome = () => {
      throw new Error('exchange down');
    };
    const store = new MemoryStateStore();
    const jobs = [fetch.definition, parse.definition];

    const first = await runTick(jobs, store);
    assert.deepEqual(statuses(first), { fetch: 'failed', parse: 'ok' }, 'parse still handles hours stored before the failure');
    assert.equal(first.jobs[0]?.reason, 'exchange down');
    assert.ok(tickFailed(first));

    assert.deepEqual(statuses(await runTick(jobs, store)), { fetch: 'failed', parse: 'up-to-date' });
    assert.equal(store.states.get('fetch')?.consecutiveFailures, 2);
    assert.equal(store.states.get('fetch')?.lastError, 'exchange down');

    fetch.outcome = () => ({ outputWatermark: 'h1', details: {} });
    assert.deepEqual(statuses(await runTick(jobs, store)), { fetch: 'ok', parse: 'up-to-date' });
    assert.equal(store.states.get('fetch')?.consecutiveFailures, 0);
  });

  it('records a reported problem as a failure and retries it', async () => {
    const parse = fakeJob('parse');
    parse.outcome = () => ({ outputWatermark: 'h1', details: { failed: 1 }, problem: '1 hours failed validation' });
    const store = new MemoryStateStore();
    await runTick([parse.definition], store);
    await runTick([parse.definition], store);
    assert.equal(parse.runs, 2);
    assert.deepEqual(store.runs.map((r) => [r.status, r.error]), [
      ['failed', '1 hours failed validation'],
      ['failed', '1 hours failed validation'],
    ]);
  });

  it('records a held stage lock as busy, not failed, and retries it', async () => {
    const fetch = fakeJob('fetch');
    fetch.outcome = () => {
      throw new ConcurrentRunError('Another fetch or rebuild is already running for realm pc');
    };
    const store = new MemoryStateStore();
    const tick = await runTick([fetch.definition], store);
    assert.deepEqual(statuses(tick), { fetch: 'busy' });
    assert.ok(!tickFailed(tick));
    assert.equal(store.states.get('fetch')?.consecutiveFailures, 0);
    await runTick([fetch.definition], store);
    assert.equal(fetch.runs, 2);
  });

  it('does not store idle runs in the history', async () => {
    const fetch = fakeJob('fetch', [], { inputWatermark: undefined });
    fetch.outcome = () => ({ outputWatermark: 'h1', details: { hours_stored: 0 }, idle: true });
    const store = new MemoryStateStore();
    assert.deepEqual(statuses(await runTick([fetch.definition], store)), { fetch: 'idle' });
    assert.deepEqual(statuses(await runTick([fetch.definition], store)), { fetch: 'idle' }, 'a job without input runs every tick');
    assert.equal(store.runs.length, 0);
    assert.equal(store.states.get('fetch')?.outputWatermark, 'h1');
  });

  it('runs only the named jobs with --only, and everything due with --force', async () => {
    const parse = fakeJob('parse');
    const metrics = fakeJob('metrics', ['parse']);
    const check = fakeJob('check', ['parse'], { inputWatermark: undefined, due: () => false });
    const store = new MemoryStateStore();
    const jobs = [parse.definition, metrics.definition, check.definition];

    assert.deepEqual(statuses(await runTick(jobs, store, { only: ['metrics'] })), { metrics: 'ok' });
    assert.deepEqual(statuses(await runTick(jobs, store)), { parse: 'ok', metrics: 'up-to-date', check: 'not-due' });
    assert.deepEqual(statuses(await runTick(jobs, store, { force: true })), { parse: 'ok', metrics: 'ok', check: 'ok' });
    await assert.rejects(runTick(jobs, store, { only: ['nope'] }), /unknown job nope/);
  });

  it('runs and records nothing in a dry run', async () => {
    const parse = fakeJob('parse');
    const store = new MemoryStateStore();
    const tick = await runTick([parse.definition], store, { dryRun: true });
    assert.equal(tick.jobs[0]?.reason, 'would run on input h1');
    assert.equal(parse.runs, 0);
    assert.equal(store.states.size, 0);
  });

  it('stops the tick when a job is interrupted', async () => {
    const fetch = fakeJob('fetch');
    const parse = fakeJob('parse', ['fetch']);
    fetch.outcome = () => ({ outputWatermark: null, details: {}, interrupted: true });
    const tick = await runTick([fetch.definition, parse.definition], new MemoryStateStore());
    assert.deepEqual(statuses(tick), { fetch: 'interrupted' });
    assert.ok(tick.stopped);
    assert.equal(parse.runs, 0);
  });

  it('asks a job to stop at its timeout and records it as timed out', async () => {
    let sawStop = false;
    const slow: Job = {
      name: 'slow',
      dependsOn: [],
      timeoutMs: 20,
      run: async (ctx) => {
        while (!ctx.shouldStop()) await new Promise((resolve) => setTimeout(resolve, 5));
        sawStop = true;
        return { outputWatermark: null, details: {}, interrupted: true };
      },
    };
    const store = new MemoryStateStore();
    const tick = await runTick([slow], store);
    assert.ok(sawStop);
    assert.deepEqual(statuses(tick), { slow: 'timeout' });
    assert.ok(tickFailed(tick));
    assert.equal(store.states.get('slow')?.consecutiveFailures, 1);
  });
});

describe('dailyAfterMidnightUtc', () => {
  const state = (lastRunAt: string) => ({
    lastStatus: 'ok',
    lastRunAt: new Date(lastRunAt),
    inputWatermark: null,
    outputWatermark: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  });

  it('is due once per UTC day', () => {
    assert.ok(dailyAfterMidnightUtc(new Date('2026-11-12T10:01:00Z'), undefined));
    assert.ok(!dailyAfterMidnightUtc(new Date('2026-11-12T23:59:00Z'), state('2026-11-12T00:01:00Z')));
    assert.ok(dailyAfterMidnightUtc(new Date('2026-11-13T00:01:00Z'), state('2026-11-12T23:59:00Z')));
  });
});

describe('nextTickDelay', () => {
  const MIN = 60_000;
  const tick = (outputWatermark: string | null, stopReason = 'caught-up'): TickResult => ({
    tickId: 't',
    stopped: false,
    jobs: [{ job: 'fetch', status: 'ok', inputWatermark: null, outputWatermark, details: { stop_reason: stopReason } }],
  });

  it('waits for hh:01 once the newest completed hour is stored', () => {
    assert.equal(nextTickDelay(new Date('2026-11-12T10:01:30Z'), tick('2026-11-12T09:00:00.000Z')), 59.5 * MIN);
    assert.equal(nextTickDelay(new Date('2026-11-12T10:00:30Z'), tick('2026-11-12T09:00:00.000Z')), 0.5 * MIN);
  });

  it('retries every 5 minutes until hh:30 while the hour is not published', () => {
    assert.equal(nextTickDelay(new Date('2026-11-12T10:01:30Z'), tick('2026-11-12T08:00:00.000Z')), 5 * MIN);
    assert.equal(nextTickDelay(new Date('2026-11-12T10:29:00Z'), tick(null)), 5 * MIN);
    assert.equal(nextTickDelay(new Date('2026-11-12T10:31:00Z'), tick('2026-11-12T08:00:00.000Z')), 30 * MIN);
  });

  it('starts the next tick at once while fetch works through a backlog', () => {
    assert.equal(nextTickDelay(new Date('2026-11-12T10:05:00Z'), tick('2026-11-11T08:00:00.000Z', 'limit')), 0);
  });

  it('retries when fetch did not run or failed', () => {
    const failed: TickResult = { tickId: 't', stopped: false, jobs: [{ job: 'fetch', status: 'failed', inputWatermark: null, outputWatermark: null }] };
    assert.equal(nextTickDelay(new Date('2026-11-12T10:10:00Z'), failed), 5 * MIN);
  });
});
