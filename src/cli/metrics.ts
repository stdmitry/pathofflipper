import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { hourIso, parseStart } from '../exchange/hours.ts';
import { createLogger, errorMessage } from '../log.ts';
import { CALC_VERSION } from '../market/metrics.ts';
import { QUOTE_NAMES } from '../market/quotes.ts';
import { computeMetrics } from '../metrics-run.ts';

const USAGE = `Compute market metrics for Chaos Orb and Divine Orb markets over the last hour and the last 24 hours.

Usage: npm run metrics [-- --as-of <hour>]

  --as-of <hour>   Newest hour of the windows: unix seconds or an ISO time with a zone. Default: the newest parsed hour.

Replaces each quote's stored snapshot of calculation version ${CALC_VERSION} in one transaction. Run it after npm run parse.
Definitions and thresholds: specs/market-metrics.md.

Exit codes: 0 computed, 1 failed, 2 invalid configuration.`;

const logger = createLogger();

function parseAsOf(value: string): number {
  try {
    const start = parseStart(value);
    if (start.kind === 'hour') return start.cursor;
  } catch (error) {
    throw new ConfigError(errorMessage(error).replace('--start', '--as-of'));
  }
  throw new ConfigError('--as-of must be an hour, not "earliest"');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'as-of': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  let asOfHour: number | undefined;
  if (values['as-of'] !== undefined) {
    asOfHour = parseAsOf(values['as-of']);
  }
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 2 });
  try {
    for (const quote of QUOTE_NAMES) {
      const summary = await computeMetrics(pool, { asOfHour, quote, logger });
      logger.info('metrics finished', {
        quote,
        as_of: summary.asOfHour === null ? undefined : hourIso(summary.asOfHour),
        parsed_hours: summary.windowHours.parsed,
        empty_hours: summary.windowHours.empty,
        missing_hours: summary.windowHours.missing,
        leagues: summary.leagues,
        markets: summary.markets,
        rows: summary.rows,
        eligible: summary.eligible,
      });
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'metrics failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
