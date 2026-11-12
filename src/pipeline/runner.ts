import { randomUUID } from 'node:crypto';
import { ConcurrentRunError } from '../ingest.ts';
import { errorMessage, silentLogger, type Logger } from '../log.ts';
import { type Job, type JobOutcome, type JobState, type JobStatus, orderJobs, RECORDED_STATUSES } from './job.ts';

export interface JobRunRecord {
  tickId: string;
  job: string;
  status: JobStatus;
  inputWatermark: string | null;
  outputWatermark: string | null;
  startedAt: Date;
  finishedAt: Date;
  details: Record<string, unknown> | null;
  error: string | null;
}

/** Where job state and run history live: PostgreSQL in production, memory in unit tests. */
export interface StateStore {
  load(): Promise<Map<string, JobState>>;
  /** Called only for runs that executed (ok, idle, failed, busy, timeout, interrupted). */
  record(run: JobRunRecord): Promise<void>;
}

export interface TickOptions {
  /** Run only these jobs, in dependency order, and nothing downstream of them. */
  only?: readonly string[];
  /** Run jobs even when they are not due or their input has not changed. */
  force?: boolean;
  /** Decide which jobs are due and why, without running or recording anything. */
  dryRun?: boolean;
  now?: () => Date;
  shouldStop?: () => boolean;
  logger?: Logger;
}

export interface JobResult {
  job: string;
  status: JobStatus;
  /** Why the job was skipped, or the error it failed with. */
  reason?: string;
  inputWatermark: string | null;
  outputWatermark: string | null;
  details?: Record<string, unknown>;
  durationMs?: number;
}

export interface TickResult {
  tickId: string;
  jobs: JobResult[];
  /** True when the tick stopped early because shouldStop() turned true. */
  stopped: boolean;
}

/** True when some job failed or timed out; busy and interrupted are not failures. */
export function tickFailed(result: TickResult): boolean {
  return result.jobs.some((j) => j.status === 'failed' || j.status === 'timeout');
}

/**
 * Runs one tick: every due job in dependency order, each when its input changed since its last successful run. A failed
 * job never stops the tick; downstream jobs check their own inputs, so data an upstream job stored before failing is
 * still processed.
 */
export async function runTick(jobs: readonly Job[], store: StateStore, options: TickOptions = {}): Promise<TickResult> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const shouldStop = options.shouldStop ?? (() => false);
  const ordered = orderJobs(jobs);
  if (options.only) {
    for (const name of options.only) if (!ordered.some((j) => j.name === name)) throw new Error(`unknown job ${name}`);
  }
  const selected = options.only ? ordered.filter((j) => options.only!.includes(j.name)) : ordered;
  const states = await store.load();
  const tick: TickResult = { tickId: randomUUID(), jobs: [], stopped: false };

  for (const job of selected) {
    if (shouldStop()) {
      tick.stopped = true;
      break;
    }
    const state = states.get(job.name);
    const skip = (status: JobStatus, reason: string, input: string | null = null) => {
      tick.jobs.push({ job: job.name, status, reason, inputWatermark: input, outputWatermark: state?.outputWatermark ?? null });
    };
    if (job.due && !options.force && !job.due(now(), state)) {
      skip('not-due', 'not due yet');
      continue;
    }
    let input: string | null = null;
    if (job.inputWatermark) {
      input = await job.inputWatermark();
      if (input === null) {
        skip('waiting', 'no input yet');
        continue;
      }
      if (!options.force && state?.lastStatus !== undefined && input === state.inputWatermark && isSettled(state)) {
        skip('up-to-date', 'input unchanged since the last successful run', input);
        continue;
      }
    }
    if (options.dryRun) {
      skip('ok', input === null ? 'would run (due)' : `would run on input ${input}`, input);
      continue;
    }

    const result = await execute(job, input, tick.tickId, { logger, now, shouldStop });
    tick.jobs.push(result.result);
    await store.record(result.record);
    states.set(job.name, applyRecord(state, result.record));
    const fields = { job: job.name, status: result.result.status, duration_ms: result.result.durationMs, ...result.result.details };
    if (result.result.status === 'failed' || result.result.status === 'timeout') {
      logger.error('job failed', { ...fields, error: result.result.reason });
    } else {
      logger.info('job finished', fields);
    }
    if (result.result.status === 'interrupted') {
      tick.stopped = true;
      break;
    }
  }
  return tick;
}

/** A job whose last run failed is retried every tick, even on unchanged input. */
function isSettled(state: JobState): boolean {
  return state.lastStatus === 'ok' || state.lastStatus === 'idle';
}

async function execute(
  job: Job,
  input: string | null,
  tickId: string,
  env: { logger: Logger; now: () => Date; shouldStop: () => boolean },
): Promise<{ result: JobResult; record: JobRunRecord }> {
  const startedAt = env.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    env.logger.warn('job timed out; asking it to stop', { job: job.name, timeout_ms: job.timeoutMs });
  }, job.timeoutMs);
  let status: JobStatus;
  let outcome: JobOutcome | undefined;
  let error: string | null = null;
  try {
    outcome = await job.run({ logger: env.logger, now: startedAt, shouldStop: () => timedOut || env.shouldStop() });
    if (timedOut) {
      status = 'timeout';
      error = `stopped after the ${job.timeoutMs} ms timeout`;
    } else if (outcome.problem) {
      status = 'failed';
      error = outcome.problem;
    } else if (outcome.interrupted) {
      status = 'interrupted';
    } else {
      status = outcome.idle ? 'idle' : 'ok';
    }
  } catch (thrown) {
    error = errorMessage(thrown);
    status = thrown instanceof ConcurrentRunError ? 'busy' : timedOut ? 'timeout' : 'failed';
  } finally {
    clearTimeout(timer);
  }
  const finishedAt = env.now();
  const record: JobRunRecord = {
    tickId,
    job: job.name,
    status,
    inputWatermark: input,
    outputWatermark: outcome?.outputWatermark ?? null,
    startedAt,
    finishedAt,
    details: outcome?.details ?? null,
    error,
  };
  return {
    record,
    result: {
      job: job.name,
      status,
      ...(error === null ? {} : { reason: error }),
      inputWatermark: input,
      outputWatermark: record.outputWatermark,
      ...(outcome ? { details: outcome.details } : {}),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
  };
}

/** The job state after a run; the PostgreSQL store implements the same rules in SQL. */
export function applyRecord(state: JobState | undefined, run: JobRunRecord): JobState {
  const base: JobState = state ?? {
    lastStatus: run.status,
    lastRunAt: run.finishedAt,
    inputWatermark: null,
    outputWatermark: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  };
  const next: JobState = { ...base, lastStatus: run.status, lastRunAt: run.finishedAt };
  if (run.status === 'ok' || run.status === 'idle') {
    next.inputWatermark = run.inputWatermark;
    if (run.status === 'ok' || run.outputWatermark !== null) next.outputWatermark = run.outputWatermark;
    next.lastSuccessAt = run.finishedAt;
    next.consecutiveFailures = 0;
  } else if (run.status === 'failed' || run.status === 'timeout') {
    next.lastError = run.error;
    next.lastErrorAt = run.finishedAt;
    next.consecutiveFailures = base.consecutiveFailures + 1;
  }
  return next;
}

export function isRecorded(status: JobStatus): boolean {
  return RECORDED_STATUSES.includes(status);
}

/** Keeps state and runs in memory; for tests and --dry-run. */
export class MemoryStateStore implements StateStore {
  readonly states = new Map<string, JobState>();
  readonly runs: JobRunRecord[] = [];

  async load(): Promise<Map<string, JobState>> {
    return new Map(this.states);
  }

  async record(run: JobRunRecord): Promise<void> {
    this.states.set(run.job, applyRecord(this.states.get(run.job), run));
    if (isRecorded(run.status)) this.runs.push(run);
  }
}
