import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, parseNonNegativeInt, parsePositiveInt, requireEnv, userAgent } from '../config.ts';
import { ExchangeClient } from '../exchange/client.ts';
import { errorMessage, type Logger } from '../log.ts';
import type { Job } from './job.ts';
import { createJobs, JOB_NAMES } from './jobs.ts';
import type { TickResult } from './runner.ts';

export const OPTIONS_USAGE = `Options:
  --only <job,...>   Run only these jobs (${JOB_NAMES.join(', ')}), nothing downstream of them
  --force            Run jobs even when not due or when their input has not changed
  --dry-run          Print which jobs are due and why; run and record nothing
  --max-hours <n>    Hours fetched per tick at most (default: POE_MAX_HOURS or 24)
  --pause-ms <ms>    Pause between exchange requests (default: 1000)
  -h, --help         Show this help`;

export interface PipelineCli {
  help: boolean;
  only?: string[];
  force: boolean;
  dryRun: boolean;
  pool: pg.Pool;
  jobs: Job[];
}

/** Parses the shared options, validates them before connecting, and builds the pool and jobs. */
export function setupPipeline(logger: Logger): PipelineCli | { help: true } {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'max-hours': { type: 'string' },
      'pause-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true };
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of only ?? []) {
    if (!(JOB_NAMES as readonly string[]).includes(name)) throw new ConfigError(`--only: unknown job "${name}"; jobs: ${JOB_NAMES.join(', ')}`);
  }
  const maxHours = parsePositiveInt('--max-hours', values['max-hours'] ?? process.env.POE_MAX_HOURS ?? '24');
  const pauseMs = parseNonNegativeInt('--pause-ms', values['pause-ms'] ?? '1000');
  const databaseUrl = requireEnv('DATABASE_URL');
  const contact = requireEnv('POE_USER_AGENT_CONTACT');

  // A tick holds the pipeline lock, a stage lock and a query connection at once.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  pool.on('error', (error) => logger.error('idle database connection failed', { error: errorMessage(error) }));
  const exchange = new ExchangeClient({ userAgent: userAgent(contact), logger });
  return {
    help: false,
    ...(only ? { only } : {}),
    force: values.force,
    dryRun: values['dry-run'],
    pool,
    jobs: createJobs(pool, { exchange, maxHours, pauseMs }),
  };
}

/** One line per job that ran, plus a summary of the skipped ones. */
export function logTick(logger: Logger, tick: TickResult, dryRun: boolean): void {
  if (dryRun) {
    for (const j of tick.jobs) {
      console.log(`${j.job.padEnd(16)} ${j.status === 'ok' ? 'due' : j.status.padEnd(10)}  ${j.reason ?? ''}`);
    }
    return;
  }
  const skipped = tick.jobs.filter((j) => ['up-to-date', 'waiting', 'not-due'].includes(j.status));
  logger.info('tick finished', {
    tick: tick.tickId,
    ran: tick.jobs.filter((j) => !skipped.includes(j)).map((j) => `${j.job}:${j.status}`).join(',') || 'none',
    skipped: skipped.map((j) => `${j.job}:${j.status}`).join(',') || 'none',
    stopped: tick.stopped || undefined,
  });
}
