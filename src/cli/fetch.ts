import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, parseNonNegativeInt, parsePositiveInt, parseRealm, requireEnv, userAgent } from '../config.ts';
import { ExchangeClient } from '../exchange/client.ts';
import { defaultStart, hourIso, parseStart } from '../exchange/hours.ts';
import { ingest } from '../ingest.ts';
import { loadItemNames } from '../items.ts';
import { createLogger, errorMessage } from '../log.ts';

const USAGE = `Fetch completed hours of PoE 1 PC currency exchange history into PostgreSQL.

Usage: npm run fetch -- [options]

Options:
  --realm <pc>            Only pc (PoE 1 PC) is supported; other values are rejected
                          (default: POE_REALM or pc)
  --max-hours <n>         Stop after storing n hours (default: POE_MAX_HOURS or 24)
  --start <when>          First hour when no cursor is stored yet: "earliest", unix seconds,
                          or an ISO time such as 2026-09-22T00:00Z (default: 24 hours ago).
                          Ignored once a cursor exists; the run resumes from the cursor.
  --pause-ms <ms>         Pause between requests (default: 1000)
  -h, --help              Show this help

Exit codes: 0 success (limit reached or caught up), 1 fetch failed, 2 invalid configuration.`;

const logger = createLogger();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      realm: { type: 'string' },
      'max-hours': { type: 'string' },
      start: { type: 'string' },
      'pause-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  // Validated before anything connects, so an unsupported realm never fetches or writes.
  const realm = parseRealm(values.realm ?? process.env.POE_REALM ?? 'pc');
  const maxHours = parsePositiveInt('--max-hours', values['max-hours'] ?? process.env.POE_MAX_HOURS ?? '24');
  const pauseMs = parseNonNegativeInt('--pause-ms', values['pause-ms'] ?? '1000');
  let start;
  try {
    start = values.start === undefined ? defaultStart(new Date()) : parseStart(values.start);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  const databaseUrl = requireEnv('DATABASE_URL');
  const contact = requireEnv('POE_USER_AGENT_CONTACT');

  // First Ctrl+C finishes the current hour and stops; a second one exits immediately.
  let stopRequested = false;
  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    logger.warn('interrupt received; stopping after the current hour (press Ctrl+C again to abort)');
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  pool.on('error', (error) => logger.error('idle database connection failed', { error: errorMessage(error) }));
  try {
    const client = new ExchangeClient({ userAgent: userAgent(contact), logger });
    const summary = await ingest(pool, client, {
      maxHours,
      start,
      pauseMs,
      itemNames: await loadItemNames(),
      shouldStop: () => stopRequested,
      logger,
    });
    logger.info('fetch finished', {
      realm,
      stop_reason: summary.stopReason,
      hours_stored: summary.hoursStored,
      markets_inserted: summary.marketsInserted,
      markets_already_stored: summary.marketsAlreadyStored,
      next_hour: summary.nextCursor === null ? undefined : hourIso(summary.nextCursor),
    });
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'fetch failed', { error: errorMessage(error) });
  if (configError) console.error(`\n${USAGE}`);
  process.exitCode = configError ? 2 : 1;
}
