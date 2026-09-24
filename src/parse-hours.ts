import type pg from 'pg';
import { REALM } from './config.ts';
import { storeMarkets } from './db/markets.ts';
import { hourIso } from './exchange/hours.ts';
import { MalformedResponseError, parseMarkets, PARSER_VERSION } from './exchange/parse.ts';
import { withParseLock } from './ingest.ts';
import type { ItemNames } from './items.ts';
import { errorMessage, silentLogger, type Logger } from './log.ts';

export interface ParseOptions {
  /** Display names for new items; paths missing here are stored without a name. */
  itemNames: ItemNames;
  /** Checked before each hour; returning true ends the run after the current hour. */
  shouldStop?: () => boolean;
  logger?: Logger;
}

export interface HourProblem {
  sourceHour: string;
  problem: string;
}

export interface ParseSummary {
  stopped: boolean;
  hoursPending: number;
  hoursParsed: number;
  rowsInserted: number;
  /** Digests that fail the current parser; they stay pending with parse_error set. */
  failedHours: HourProblem[];
}

/**
 * Parses one stored digest's markets into the dictionaries and pair_hours inside the caller's transaction.
 * Returns the number of markets in the payload and the pair_hours rows inserted.
 */
export async function parseStoredDigest(
  client: pg.PoolClient,
  digestId: string,
  sourceHour: number,
  itemNames: ItemNames,
): Promise<{ markets: number; inserted: number }> {
  const { rows } = await client.query<{ payload: string }>('SELECT payload::text AS payload FROM raw_digests WHERE id = $1', [
    digestId,
  ]);
  const markets = parseMarkets(rows[0]!.payload);
  const inserted = await storeMarkets(client, REALM, sourceHour, markets, itemNames);
  return { markets: markets.length, inserted };
}

/**
 * Parses every PC digest that fetch stored but no parser has handled yet (parser_version IS NULL), oldest first, one
 * transaction per hour. A digest that fails validation keeps its problems in parse_error and stays pending, so the next
 * run retries it; later hours are still parsed.
 */
export async function parsePending(pool: pg.Pool, options: ParseOptions): Promise<ParseSummary> {
  const logger = options.logger ?? silentLogger;
  return withParseLock(pool, async () => {
    const digests = await pool.query<{ id: string; source_hour: string }>(
      `SELECT id, extract(epoch FROM source_hour)::bigint AS source_hour
       FROM raw_digests WHERE realm = $1 AND parser_version IS NULL ORDER BY source_hour`,
      [REALM],
    );
    const summary: ParseSummary = {
      stopped: false,
      hoursPending: digests.rows.length,
      hoursParsed: 0,
      rowsInserted: 0,
      failedHours: [],
    };
    logger.info('parsing stored hours', { realm: REALM, pending: summary.hoursPending });

    for (const digest of digests.rows) {
      if (options.shouldStop?.()) {
        summary.stopped = true;
        break;
      }
      const sourceHour = Number(digest.source_hour);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { inserted } = await parseStoredDigest(client, digest.id, sourceHour, options.itemNames);
        await client.query('UPDATE raw_digests SET parser_version = $1, parse_error = NULL WHERE id = $2', [
          PARSER_VERSION,
          digest.id,
        ]);
        await client.query('COMMIT');
        summary.hoursParsed++;
        summary.rowsInserted += inserted;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (!(error instanceof MalformedResponseError)) throw error;
        const problem = errorMessage(error);
        summary.failedHours.push({ sourceHour: hourIso(sourceHour), problem });
        const details = error.problems.length > 0 ? error.problems.join('\n') : problem;
        await client.query('UPDATE raw_digests SET parse_error = $1 WHERE id = $2', [details, digest.id]);
        logger.error('stored hour failed validation; left pending', { source_hour: hourIso(sourceHour), error: problem });
      } finally {
        client.release();
      }

      const done = summary.hoursParsed + summary.failedHours.length;
      if (done % 500 === 0) {
        logger.info('parse progress', { parsed: summary.hoursParsed, remaining: summary.hoursPending - done });
      }
    }
    return summary;
  });
}
