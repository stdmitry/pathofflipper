import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { loadItemNames } from '../items.ts';
import { createLogger, errorMessage } from '../log.ts';
import { rebuild } from '../rebuild.ts';

const USAGE = `Rebuild pair_hours and its dictionaries from the stored raw digests (issue #13).

Usage: npm run rebuild

Hours that are already complete are skipped, so an interrupted run can simply be restarted. While market_hours
still exists, every one of its rows is compared with pair_hours. Afterwards, npm run db:migrate drops market_hours.

Exit codes: 0 rebuilt and verified, 1 failed or mismatches found, 2 invalid configuration.`;

const MAX_LISTED = 20;
const logger = createLogger();

async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return true;
  }
  const databaseUrl = requireEnv('DATABASE_URL');

  let stopRequested = false;
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    logger.warn('interrupt received; stopping after the current hour (press Ctrl+C again to abort)');
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  pool.on('error', (error) => logger.error('idle database connection failed', { error: errorMessage(error) }));
  try {
    const summary = await rebuild(pool, { itemNames: await loadItemNames(), shouldStop: () => stopRequested, logger });
    for (const { sourceHour, problem } of [...summary.invalidHours, ...summary.countMismatches].slice(0, MAX_LISTED)) {
      logger.error('hour mismatch', { source_hour: sourceHour, problem });
    }
    logger.info('rebuild finished', {
      stopped: summary.stopped,
      hours: summary.hoursTotal,
      already_complete: summary.hoursAlreadyComplete,
      rebuilt: summary.hoursRebuilt,
      rows_inserted: summary.rowsInserted,
      invalid_hours: summary.invalidHours.length,
      count_mismatches: summary.countMismatches.length,
      value_mismatches: summary.valueMismatches ?? 'market_hours already dropped',
    });
    return (
      !summary.stopped &&
      summary.invalidHours.length === 0 &&
      summary.countMismatches.length === 0 &&
      !summary.valueMismatches
    );
  } finally {
    await pool.end();
  }
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'rebuild failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
