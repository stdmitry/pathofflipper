import { ConfigError } from '../config.ts';
import { createLogger, errorMessage } from '../log.ts';
import { runPipelineTick, tickFailed } from '../pipeline/index.ts';
import { logTick, OPTIONS_USAGE, setupPipeline } from '../pipeline/setup.ts';

const USAGE = `Run one pipeline tick: fetch → parse → metrics → runegraft, and check-semantics once a day, then exit.

Usage: npm run pipeline -- [options]

A job runs when its input changed since its last successful run; a failed job is retried in the next tick. Safe to
call often (e.g. from cron every 5 minutes): a tick that finds another one running exits 0, and a tick with nothing
new does nothing. State: job_state and job_runs. Spec: specs/scheduled-pipeline-spec.md.

${OPTIONS_USAGE}

Exit codes: 0 no job failed (or another tick is running), 1 a job failed, 2 invalid configuration.`;

const logger = createLogger();

async function main(): Promise<boolean> {
  const setup = setupPipeline(logger);
  if (setup.help) {
    console.log(USAGE);
    return true;
  }
  // First Ctrl+C lets the current job finish its current unit of work; a second exits immediately.
  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    logger.warn('stop requested; finishing the current job step (press Ctrl+C again to abort)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const tick = await runPipelineTick(setup.pool, setup.jobs, {
      ...(setup.only ? { only: setup.only } : {}),
      force: setup.force,
      dryRun: setup.dryRun,
      shouldStop: () => stopRequested,
      logger,
    });
    if (tick === null) return true;
    logTick(logger, tick, setup.dryRun);
    return !tickFailed(tick);
  } finally {
    await setup.pool.end();
  }
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'pipeline failed', { error: errorMessage(error) });
  if (configError) console.error(`\n${USAGE}`);
  process.exitCode = configError ? 2 : 1;
}
