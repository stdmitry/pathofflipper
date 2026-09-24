import type pg from 'pg';
import { REALM } from './config.ts';
import type { ExchangeResponse, ExchangeSource } from './exchange/client.ts';
import { hourIso, type StartPoint } from './exchange/hours.ts';
import { interpretEnvelope, MalformedResponseError, sha256 } from './exchange/parse.ts';
import { errorMessage, silentLogger, type Logger } from './log.ts';

// Advisory lock namespaces; the second key is the realm, kept so the ingest lock matches earlier releases.
const INGEST_LOCK_NAMESPACE = 7_319_001;
const PARSE_LOCK_NAMESPACE = 7_319_002;
const METRICS_LOCK_NAMESPACE = 7_319_003;

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
  /** Cursor the next run will request, or null if nothing has been committed yet. */
  nextCursor: number | null;
}

export class ConcurrentRunError extends Error {
  override name = 'ConcurrentRunError';
}

/** Runs `fn` while holding the PC ingest lock, shared by fetch and rebuild so they never write concurrently. */
export function withIngestLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  return withRealmLock(pool, INGEST_LOCK_NAMESPACE, 'fetch or rebuild', fn);
}

/** Runs `fn` while holding the PC parse lock, shared by parse and rebuild so pair_hours has one writer. */
export function withParseLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  return withRealmLock(pool, PARSE_LOCK_NAMESPACE, 'parse or rebuild', fn);
}

/** Runs `fn` while holding the PC metrics lock, so two metric runs never replace each other's snapshot. */
export function withMetricsLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  return withRealmLock(pool, METRICS_LOCK_NAMESPACE, 'metrics run', fn);
}

async function withRealmLock<T>(pool: pg.Pool, namespace: number, holders: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [namespace, REALM],
    );
    if (!rows[0]?.locked) throw new ConcurrentRunError(`Another ${holders} is already running for realm ${REALM}`);
    try {
      return await fn();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', [namespace, REALM]);
    }
  } finally {
    lockClient.release();
  }
}

/**
 * Fetches completed PoE 1 PC hours starting at the stored PC cursor (or `start` on the first run) and stores each raw
 * response and the cursor advance atomically. Market records are left for parsePending, so a record the parser rejects
 * never stops collection.
 */
export async function ingest(pool: pg.Pool, source: ExchangeSource, options: IngestOptions): Promise<IngestSummary> {
  const logger = options.logger ?? silentLogger;
  return withIngestLock(pool, async () => {
    try {
      return await run(pool, source, options, logger);
    } catch (error) {
      await recordFailure(pool, error, logger);
      throw error;
    }
  });
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
      result = interpretEnvelope(response.status, response.body, requestCursor);
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

    const differentResponse = await storeHour(pool, {
      requestCursor,
      expectedCursor: storedCursor,
      sourceHour: result.sourceHour,
      nextCursor: result.nextCursor,
      marketCount: result.marketCount,
      response,
      fetchedAt,
    });
    if (differentResponse) {
      logger.warn('hour was stored before from a different response; kept the stored response', {
        realm,
        source_hour: hourIso(result.sourceHour),
      });
    }

    summary.hoursStored++;
    summary.nextCursor = storedCursor = requestCursor = result.nextCursor;
    logger.info('stored hour', {
      realm,
      source_hour: hourIso(result.sourceHour),
      markets: result.marketCount,
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

/** Stores the raw digest and advances the cursor. Returns true when the hour was already stored from a different response. */
async function storeHour(pool: pg.Pool, input: StoreHourInput): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The body is cast to jsonb by PostgreSQL, so numbers keep their exact decimal value.
    const checksum = sha256(input.response.body);
    const digest = await client.query<{ checksum: string }>(
      `INSERT INTO raw_digests (realm, request_cursor, next_cursor, source_hour, http_status, market_count,
                                checksum, payload, first_fetched_at, last_fetched_at)
       VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8::jsonb, $9, $9)
       ON CONFLICT (realm, source_hour) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at
       RETURNING checksum`,
      [
        REALM,
        input.requestCursor,
        input.nextCursor,
        input.sourceHour,
        input.response.status,
        input.marketCount,
        checksum,
        input.response.body,
        input.fetchedAt,
      ],
    );
    const digestRow = digest.rows[0];
    if (!digestRow) throw new Error('raw digest insert returned no row');

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
    return digestRow.checksum !== checksum;
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
