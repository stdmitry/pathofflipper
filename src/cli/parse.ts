import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { loadItemNames } from '../items.ts';
import { createLogger, errorMessage } from '../log.ts';
import { parsePending } from '../parse-hours.ts';

const USAGE = `Parse fetched PoE 1 PC hours into pair_hours and its dictionaries.

Usage: npm run parse

Handles every stored hour that has not been parsed yet, oldest first, one transaction per hour. An hour that fails
validation keeps its problems in raw_digests.parse_error and is retried by the next run; later hours are still parsed.
Can run while a fetch is running.

Exit codes: 0 every pending hour parsed, 1 failed or some hours failed validation, 2 invalid configuration.`;

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
    const summary = await parsePending(pool, { itemNames: await loadItemNames(), shouldStop: () => stopRequested, logger });
    for (const { sourceHour, problem } of summary.failedHours.slice(0, MAX_LISTED)) {
      logger.error('hour failed validation', { source_hour: sourceHour, problem });
    }
    logger.info('parse finished', {
      stopped: summary.stopped,
      pending: summary.hoursPending,
      parsed: summary.hoursParsed,
      rows_inserted: summary.rowsInserted,
      failed: summary.failedHours.length,
    });
    return summary.failedHours.length === 0;
  } finally {
    await pool.end();
  }
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'parse failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
