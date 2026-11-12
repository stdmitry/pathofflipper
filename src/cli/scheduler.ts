import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError } from '../config.ts';
import { createLogger, errorMessage } from '../log.ts';
import { runPipelineTick } from '../pipeline/index.ts';
import { nextTickDelay, RETRY_MS } from '../pipeline/schedule.ts';
import { logTick, OPTIONS_USAGE, setupPipeline } from '../pipeline/setup.ts';

const USAGE = `Run pipeline ticks on a timer until stopped: one now, then at hh:01 each hour, retrying every 5 minutes until
hh:30 while the newest hour is not published yet, and immediately again while fetch is working through a backlog.

Usage: npm run scheduler -- [options]

Each tick is what npm run pipeline does. Spec: specs/scheduled-pipeline-spec.md.

${OPTIONS_USAGE}

Exit codes: 0 stopped by a signal, 1 failed, 2 invalid configuration.`;

const logger = createLogger();

async function main(): Promise<void> {
  const setup = setupPipeline(logger);
  if (setup.help) {
    console.log(USAGE);
    return;
  }
  if (setup.dryRun) throw new ConfigError('--dry-run is for npm run pipeline');

  let stopRequested = false;
  const wake = new AbortController();
  const onSignal = () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    wake.abort();
    logger.warn('stop requested; finishing the current job step (press Ctrl+C again to abort)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    while (!stopRequested) {
      let delay = RETRY_MS;
      try {
        const tick = await runPipelineTick(setup.pool, setup.jobs, {
          ...(setup.only ? { only: setup.only } : {}),
          force: setup.force,
          shouldStop: () => stopRequested,
          logger,
        });
        if (tick) {
          logTick(logger, tick, false);
          delay = nextTickDelay(new Date(), tick);
        }
      } catch (error) {
        // E.g. the database is down: keep the scheduler alive and try again later.
        logger.error('tick failed', { error: errorMessage(error) });
      }
      if (stopRequested) break;
      logger.info('next tick', { at: new Date(Date.now() + delay).toISOString() });
      await sleep(delay, undefined, { signal: wake.signal }).catch(() => {});
    }
  } finally {
    await setup.pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'scheduler failed', { error: errorMessage(error) });
  if (configError) console.error(`\n${USAGE}`);
  process.exitCode = configError ? 2 : 1;
}
