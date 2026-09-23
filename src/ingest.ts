import type pg from 'pg';
import { REALM } from './config.ts';
import type { ExchangeResponse, ExchangeSource } from './exchange/client.ts';
import { hourIso, type StartPoint } from './exchange/hours.ts';
import { interpretResponse, MalformedResponseError, PARSER_VERSION, sha256 } from './exchange/parse.ts';
import { errorMessage, silentLogger, type Logger } from './log.ts';

// Advisory lock namespace; the second key is the realm, kept so the lock matches earlier releases.
const INGEST_LOCK_NAMESPACE = 7_319_001;

export interface IngestOptions {
  /** Upper bound on hours stored in this run. */
  maxHours: number;
  /** Used only when no PC cursor is stored yet. */
  start: StartPoint;
  /** Pause between successful requests. */
  pauseMs?: number;
  /** Checked before each request; returning true ends the run after the current hour. */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logger?: Logger;
}

export type StopReason = 'caught-up' | 'limit' | 'interrupted';

export interface IngestSummary {
  stopReason: StopReason;
  hoursStored: number;
  marketsInserted: number;
  marketsAlreadyStored: number;
  /** Cursor the next run will request, or null if nothing has been committed yet. */
  nextCursor: number | null;
}

export class ConcurrentRunError extends Error {
  override name = 'ConcurrentRunError';
}

/**
 * Fetches completed PoE 1 PC hours starting at the stored PC cursor (or `start` on the first run) and stores
 * each one atomically: raw digest, market rows and cursor advance commit together or not at all.
 */
export async function ingest(pool: pg.Pool, source: ExchangeSource, options: IngestOptions): Promise<IngestSummary> {
  const logger = options.logger ?? silentLogger;
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [INGEST_LOCK_NAMESPACE, REALM],
    );
    if (!rows[0]?.locked) throw new ConcurrentRunError(`Another fetch is already running for realm ${REALM}`);
    try {
      return await run(pool, source, options, logger);
    } catch (error) {
      await recordFailure(pool, error, logger);
      throw error;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [INGEST_LOCK_NAMESPACE, REALM]);
    }
  } finally {
    lockClient.release();
  }
}

async function run(pool: pg.Pool, source: ExchangeSource, options: IngestOptions, logger: Logger): Promise<IngestSummary> {
  const { maxHours } = options;
  const realm = REALM;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let storedCursor = await readCursor(pool);
  let requestCursor: number | null;
  if (storedCursor === null) {
    requestCursor = options.start.kind === 'hour' ? options.start.cursor : null;
    logger.info('no stored cursor; starting from bootstrap point', {
      realm,
      start: requestCursor === null ? 'earliest' : hourIso(requestCursor),
    });
  } else {
    requestCursor = storedCursor;
    logger.info('resuming from stored cursor', { realm, next_hour: hourIso(storedCursor) });
  }

  const summary: IngestSummary = {
    stopReason: 'limit',
    hoursStored: 0,
    marketsInserted: 0,
    marketsAlreadyStored: 0,
    nextCursor: storedCursor,
  };

  while (summary.hoursStored < maxHours) {
    if (options.shouldStop?.()) {
      summary.stopReason = 'interrupted';
      return summary;
    }

    const response = await source.get(requestCursor);
    const fetchedAt = now();
    let result;
    try {
      result = interpretResponse(response.status, response.body, requestCursor);
    } catch (error) {
      if (error instanceof MalformedResponseError) {
        await recordRejected(pool, requestCursor, response, fetchedAt, error, logger);
      }
      throw error;
    }

    if (result.kind === 'caught-up') {
      logger.info('caught up; the next hour is not published yet', { realm, next_hour: hourIso(result.nextCursor) });
      summary.stopReason = 'caught-up';
      return summary;
    }
    if (result.skippedHours > 0) {
      logger.warn('API skipped hours; they are treated as unknown, not inactive', {
        realm,
        source_hour: hourIso(result.sourceHour),
        next_hour: hourIso(result.nextCursor),
        skipped_hours: result.skippedHours,
      });
    }

    const stored = await storeHour(pool, {
      requestCursor,
      expectedCursor: storedCursor,
      sourceHour: result.sourceHour,
      nextCursor: result.nextCursor,
      marketCount: result.marketCount,
      response,
      fetchedAt,
    });
    if (stored.digestExisted === false && stored.marketsAlreadyStored > 0) {
      logger.warn('hour was stored before from a different response; kept the existing market rows', {
        realm,
        source_hour: hourIso(result.sourceHour),
        markets_kept: stored.marketsAlreadyStored,
      });
    }

    summary.hoursStored++;
    summary.marketsInserted += stored.marketsInserted;
    summary.marketsAlreadyStored += stored.marketsAlreadyStored;
    summary.nextCursor = storedCursor = requestCursor = result.nextCursor;
    logger.info('stored hour', {
      realm,
      source_hour: hourIso(result.sourceHour),
      markets: result.marketCount,
      active_markets: result.activeMarketCount,
      inserted: stored.marketsInserted,
      already_stored: stored.marketsAlreadyStored,
      progress: `${summary.hoursStored}/${maxHours}`,
    });

    if (summary.hoursStored < maxHours && options.pauseMs) await sleep(options.pauseMs);
  }
  return summary;
}

/** The PC cursor; cursors left by other realms are never read. */
export async function readCursor(pool: pg.Pool): Promise<number | null> {
  const { rows } = await pool.query<{ next_cursor: string | null }>(
    'SELECT next_cursor FROM ingestion_cursors WHERE realm = $1',
    [REALM],
  );
  const value = rows[0]?.next_cursor;
  return value == null ? null : Number(value);
}

interface StoreHourInput {
  requestCursor: number | null;
  /** Cursor value this run last read or wrote; the update fails if another writer changed it. */
  expectedCursor: number | null;
  sourceHour: number;
  nextCursor: number;
  marketCount: number;
  response: ExchangeResponse;
  fetchedAt: Date;
}

interface StoreHourResult {
  digestExisted: boolean;
  marketsInserted: number;
  marketsAlreadyStored: number;
}

async function storeHour(pool: pg.Pool, input: StoreHourInput): Promise<StoreHourResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The body is cast to jsonb by PostgreSQL, so numbers keep their exact decimal value.
    const digest = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO raw_digests (realm, request_cursor, next_cursor, source_hour, http_status, market_count,
                                checksum, parser_version, payload, first_fetched_at, last_fetched_at)
       VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9::jsonb, $10, $10)
       ON CONFLICT (realm, source_hour, checksum) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at
       RETURNING id, (xmax = 0) AS inserted`,
      [
        REALM,
        input.requestCursor,
        input.nextCursor,
        input.sourceHour,
        input.response.status,
        input.marketCount,
        sha256(input.response.body),
        PARSER_VERSION,
        input.response.body,
        input.fetchedAt,
      ],
    );
    const digestRow = digest.rows[0];
    if (!digestRow) throw new Error('raw digest insert returned no row');

    const markets = await client.query(
      `INSERT INTO market_hours (realm, league, source_hour, market_id, item_a_id, item_b_id, volume_traded,
                                 lowest_stock, highest_stock, lowest_ratio, highest_ratio, raw_digest_id, fetched_at)
       SELECT d.realm, m->>'league', d.source_hour, m->>'market_id', m->'market_pair'->>0, m->'market_pair'->>1,
              m->'volume_traded', m->'lowest_stock', m->'highest_stock', m->'lowest_ratio', m->'highest_ratio',
              d.id, $2
       FROM raw_digests d, jsonb_array_elements(d.payload->'markets') AS m
       WHERE d.id = $1
       ON CONFLICT (realm, league, source_hour, market_id) DO NOTHING`,
      [digestRow.id, input.fetchedAt],
    );
    const marketsInserted = markets.rowCount ?? 0;

    const cursor = await client.query(
      `INSERT INTO ingestion_cursors (realm, next_cursor, last_success_at, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (realm) DO UPDATE
         SET next_cursor = EXCLUDED.next_cursor, last_success_at = EXCLUDED.last_success_at,
             last_error = NULL, last_error_at = NULL, updated_at = now()
         WHERE ingestion_cursors.next_cursor IS NOT DISTINCT FROM $4::bigint`,
      [REALM, input.nextCursor, input.fetchedAt, input.expectedCursor],
    );
    if (cursor.rowCount !== 1) {
      throw new ConcurrentRunError(`Cursor for realm ${REALM} changed during the run; nothing was stored`);
    }

    await client.query('COMMIT');
    return {
      digestExisted: !digestRow.inserted,
      marketsInserted,
      marketsAlreadyStored: input.marketCount - marketsInserted,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recordRejected(
  pool: pg.Pool,
  requestCursor: number | null,
  response: ExchangeResponse,
  fetchedAt: Date,
  error: MalformedResponseError,
  logger: Logger,
): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO rejected_responses (realm, request_cursor, http_status, checksum, problems, body, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [REALM, requestCursor, response.status, sha256(response.body), JSON.stringify(error.problems), response.body, fetchedAt],
    );
    logger.error('rejected malformed response; cursor not advanced', {
      realm: REALM,
      request_hour: requestCursor === null ? 'earliest' : hourIso(requestCursor),
      rejected_response_id: rows[0]?.id,
      problems: error.problems.length,
    });
  } catch (storeError) {
    logger.error('could not save rejected response', { error: errorMessage(storeError) });
  }
}

async function recordFailure(pool: pg.Pool, error: unknown, logger: Logger): Promise<void> {
  const message = errorMessage(error);
  try {
    await pool.query(
      `INSERT INTO ingestion_cursors (realm, last_error, last_error_at, updated_at) VALUES ($1, $2, now(), now())
       ON CONFLICT (realm) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now(), updated_at = now()`,
      [REALM, message],
    );
  } catch (recordError) {
    logger.error('could not record failure on the cursor', { error: errorMessage(recordError) });
  }
}
