import type { Logger } from '../log.ts';

/** Spec: specs/scheduled-pipeline-spec.md. */

export interface JobContext {
  logger: Logger;
  now: Date;
  /** True once the tick was asked to stop (signal or timeout); long jobs end after their current unit of work. */
  shouldStop: () => boolean;
}

export interface JobOutcome {
  /** What the job produced, for downstream inspection and /api/status; null when it produced nothing. */
  outputWatermark: string | null;
  /** The job's summary, stored in job_runs.details. */
  details: Record<string, unknown>;
  /** The job ran but found nothing new (e.g. fetch caught up with no new hour). Not stored in job_runs. */
  idle?: boolean;
  /** The job stopped early because shouldStop() turned true. */
  interrupted?: boolean;
  /** The job finished but reports a problem (e.g. hours that failed validation). Recorded as failed. */
  problem?: string;
}

export interface JobState {
  lastStatus: string;
  lastRunAt: Date;
  inputWatermark: string | null;
  outputWatermark: string | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutiveFailures: number;
}

export interface Job {
  name: string;
  dependsOn: readonly string[];
  /** Whether to consider the job in this tick at all; default every tick. */
  due?: (now: Date, state: JobState | undefined) => boolean;
  /**
   * The newest input this job would read, compared for equality with the input of its last successful run. Null means
   * the input does not exist yet (the job waits). A job without this function runs every time it is due.
   */
  inputWatermark?: () => Promise<string | null>;
  run(ctx: JobContext): Promise<JobOutcome>;
  /** After this long the job is asked to stop; it is recorded as timed out once it returns. */
  timeoutMs: number;
}

/** Statuses of one job in one tick. Only the first five are written to job_runs. */
export type JobStatus = 'ok' | 'failed' | 'busy' | 'timeout' | 'interrupted' | 'idle' | 'up-to-date' | 'waiting' | 'not-due';

export const RECORDED_STATUSES: readonly JobStatus[] = ['ok', 'failed', 'busy', 'timeout', 'interrupted'];

/** Checks names and dependencies and returns the jobs in dependency order (stable for independent jobs). */
export function orderJobs(jobs: readonly Job[]): Job[] {
  const byName = new Map<string, Job>();
  for (const job of jobs) {
    if (byName.has(job.name)) throw new Error(`duplicate job ${job.name}`);
    byName.set(job.name, job);
  }
  for (const job of jobs) {
    for (const dep of job.dependsOn) if (!byName.has(dep)) throw new Error(`job ${job.name} depends on unknown job ${dep}`);
  }
  const ordered: Job[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (job: Job, path: string[]) => {
    const seen = state.get(job.name);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`job dependency cycle: ${[...path, job.name].join(' → ')}`);
    state.set(job.name, 'visiting');
    for (const dep of job.dependsOn) visit(byName.get(dep)!, [...path, job.name]);
    state.set(job.name, 'done');
    ordered.push(job);
  };
  for (const job of jobs) visit(job, []);
  return ordered;
}
