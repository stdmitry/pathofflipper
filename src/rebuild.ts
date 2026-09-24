import type pg from 'pg';
import { REALM } from './config.ts';
import { hourIso } from './exchange/hours.ts';
import { MalformedResponseError, NUMERIC_FIELDS, PARSER_VERSION } from './exchange/parse.ts';
import { withIngestLock, withParseLock } from './ingest.ts';
import type { ItemNames } from './items.ts';
import { parseStoredDigest, type HourProblem } from './parse-hours.ts';
import { errorMessage, silentLogger, type Logger } from './log.ts';

export interface RebuildOptions {
  itemNames: ItemNames;
  /** Checked before each hour; returning true ends the run after the current hour. */
  shouldStop?: () => boolean;
  logger?: Logger;
}

export interface RebuildSummary {
  stopped: boolean;
  hoursTotal: number;
  hoursAlreadyComplete: number;
  hoursRebuilt: number;
  rowsInserted: number;
  /** Stored digests that fail the current parser; their hours stay incomplete. */
  invalidHours: HourProblem[];
  /** Hours whose pair_hours row count differs from the digest's market count, or from market_hours. */
  countMismatches: HourProblem[];
  /** market_hours rows without an identical pair_hours row; null when market_hours no longer exists. */
  valueMismatches: number | null;
}

/**
 * Re-parses stored raw digests into the dictionaries and pair_hours, one transaction per hour, skipping hours that
 * are already complete, so an interrupted run resumes. While market_hours exists, verifies counts and values against it.
 */
export async function rebuild(pool: pg.Pool, options: RebuildOptions): Promise<RebuildSummary> {
  const logger = options.logger ?? silentLogger;
  return withIngestLock(pool, () => withParseLock(pool, async () => {
    const counts = await pairHourCounts(pool);
    const digests = await pool.query<{ id: string; source_hour: string; market_count: number }>(
      `SELECT id, extract(epoch FROM source_hour)::bigint AS source_hour, market_count
       FROM raw_digests WHERE realm = $1 ORDER BY source_hour`,
      [REALM],
    );
    const summary: RebuildSummary = {
      stopped: false,
      hoursTotal: digests.rows.length,
      hoursAlreadyComplete: 0,
      hoursRebuilt: 0,
      rowsInserted: 0,
      invalidHours: [],
      countMismatches: [],
      valueMismatches: null,
    };
    logger.info('rebuilding pair_hours from raw digests', { realm: REALM, hours: summary.hoursTotal });

    for (const digest of digests.rows) {
      const sourceHour = Number(digest.source_hour);
      const stored = counts.get(sourceHour) ?? 0;
      if (stored === digest.market_count) {
        summary.hoursAlreadyComplete++;
        continue;
      }
      if (options.shouldStop?.()) {
        summary.stopped = true;
        break;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { inserted } = await parseStoredDigest(client, digest.id, sourceHour, options.itemNames);
        await client.query('UPDATE raw_digests SET parser_version = $1 WHERE id = $2', [PARSER_VERSION, digest.id]);
        await client.query('COMMIT');

        summary.hoursRebuilt++;
        summary.rowsInserted += inserted;
        if (stored + inserted !== digest.market_count) {
          summary.countMismatches.push({
            sourceHour: hourIso(sourceHour),
            problem: `pair_hours has ${stored + inserted} rows, digest has ${digest.market_count} markets`,
          });
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (!(error instanceof MalformedResponseError)) throw error;
        summary.invalidHours.push({ sourceHour: hourIso(sourceHour), problem: errorMessage(error) });
        logger.error('stored digest failed validation; hour left incomplete', {
          source_hour: hourIso(sourceHour),
          error: errorMessage(error),
        });
      } finally {
        client.release();
      }

      const done = summary.hoursRebuilt + summary.invalidHours.length;
      if (done % 500 === 0) {
        logger.info('rebuild progress', { rebuilt: summary.hoursRebuilt, remaining: summary.hoursTotal - summary.hoursAlreadyComplete - done });
      }
    }

    if (!summary.stopped && (await tableExists(pool, 'market_hours'))) {
      logger.info('comparing with market_hours');
      await compareWithMarketHours(pool, summary);
    }
    return summary;
  }));
}

/** pair_hours row counts per PC hour (unix seconds). */
async function pairHourCounts(pool: pg.Pool): Promise<Map<number, number>> {
  const { rows } = await pool.query<{ source_hour: string; n: number }>(
    `SELECT extract(epoch FROM h.source_hour)::bigint AS source_hour, count(*)::int AS n
     FROM pair_hours h JOIN leagues l ON l.id = h.league_id
     WHERE l.realm = $1 GROUP BY h.source_hour`,
    [REALM],
  );
  return new Map(rows.map((row) => [Number(row.source_hour), row.n]));
}

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [table]);
  return rows[0]?.exists ?? false;
}

async function compareWithMarketHours(pool: pg.Pool, summary: RebuildSummary): Promise<void> {
  const counts = await pairHourCounts(pool);
  const old = await pool.query<{ source_hour: string; n: number }>(
    `SELECT extract(epoch FROM source_hour)::bigint AS source_hour, count(*)::int AS n
     FROM market_hours WHERE realm = $1 GROUP BY source_hour`,
    [REALM],
  );
  for (const row of old.rows) {
    const hour = Number(row.source_hour);
    const stored = counts.get(hour) ?? 0;
    if (stored !== row.n) {
      summary.countMismatches.push({ sourceHour: hourIso(hour), problem: `pair_hours has ${stored} rows, market_hours has ${row.n}` });
    }
  }

  const sameValues = NUMERIC_FIELDS.flatMap((field) => [
    `h.${field}_a = (m.${field}->>m.item_a_id)::numeric`,
    `h.${field}_b = (m.${field}->>m.item_b_id)::numeric`,
  ]).join(' AND ');
  const { rows } = await pool.query<{ matched: string }>(
    `SELECT count(h.pair_id) AS matched
     FROM market_hours m
     JOIN leagues l ON l.realm = m.realm AND l.name = m.league
     JOIN items a ON a.metadata_path = m.item_a_id
     JOIN items b ON b.metadata_path = m.item_b_id
     LEFT JOIN pairs p ON p.item_a_id = a.id AND p.item_b_id = b.id
     LEFT JOIN pair_hours h ON h.league_id = l.id AND h.pair_id = p.id AND h.source_hour = m.source_hour AND ${sameValues}
     WHERE m.realm = $1`,
    [REALM],
  );
  const oldTotal = old.rows.reduce((sum, row) => sum + row.n, 0);
  // Rows whose league or items are missing from the dictionaries drop out of the inner joins; count them as mismatches.
  summary.valueMismatches = oldTotal - Number(rows[0]?.matched ?? 0);
}
