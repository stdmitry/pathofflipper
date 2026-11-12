import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { snapshot } from './api/queries.ts';
import { REALM } from './config.ts';
import { hourIso } from './exchange/hours.ts';
import { withRunegraftLock } from './ingest.ts';
import { silentLogger, type Logger } from './log.ts';
import { WINDOWS } from './market/metrics.ts';
import { QUOTE_ITEMS } from './market/quotes.ts';
import {
  breakEvenBuyPrice,
  conversionProfit,
  DEFAULT_MARGIN,
  DEFAULT_MIN_OUTCOME_PRICE,
  expectedValue,
  INPUTS_PER_CONVERSION,
  parseWeights,
  recommendedBuyPrice,
  RUNEGRAFT_WEIGHTS_FILE,
  type RunegraftWeight,
} from './market/runegraft.ts';
import { runegraftPrices } from './runegraft-prices.ts';

export interface RunegraftWeightsFile {
  weights: RunegraftWeight[];
  /** SHA-256 of the file's bytes, stored with each run so a changed distribution is visible. */
  sha256: string;
}

export async function readWeightsFile(file = RUNEGRAFT_WEIGHTS_FILE): Promise<RunegraftWeightsFile> {
  const bytes = await readFile(file);
  return { weights: parseWeights(JSON.parse(bytes.toString('utf8'))), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface RunegraftRunOptions {
  weights: RunegraftWeightsFile;
  margin?: number;
  minOutcomePrice?: number;
  logger?: Logger;
}

export interface RunegraftRunSummary {
  /** Chaos snapshot the run was computed from; null when there is none yet, and nothing was stored. */
  asOfHour: number | null;
  metricRunId: string | null;
  /** League × window runs stored. */
  runs: number;
  items: number;
  /** Runs whose recommended price is known. */
  priced: number;
}

/**
 * Computes the Runegraft conversion EV, break-even and recommended buy price for every public league with a Runegraft
 * Chaos market in the stored Chaos snapshot, for each window, and stores them. A rerun of the same snapshot hour replaces
 * that hour's rows; other hours are kept. Same calculation as `npm run runegraft`.
 */
export async function computeRunegraftRuns(pool: pg.Pool, options: RunegraftRunOptions): Promise<RunegraftRunSummary> {
  const logger = options.logger ?? silentLogger;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const minOutcomePrice = options.minOutcomePrice ?? DEFAULT_MIN_OUTCOME_PRICE;
  const { weights, sha256 } = options.weights;
  return withRunegraftLock(pool, async () => {
    const summary: RunegraftRunSummary = { asOfHour: null, metricRunId: null, runs: 0, items: 0, priced: 0 };
    const snap = await snapshot(pool, QUOTE_ITEMS.chaos.path);
    if (!snap) {
      logger.warn('no Chaos metrics snapshot; nothing to compute');
      return summary;
    }
    summary.asOfHour = snap.asOfHour;
    summary.metricRunId = snap.runId;

    const { rows: leagues } = await pool.query<{ id: number; name: string }>(
      `SELECT DISTINCT l.id, l.name FROM market_metrics m
       JOIN leagues l ON l.id = m.league_id
       JOIN pairs p ON p.id = m.pair_id
       JOIN items base ON base.id = CASE WHEN p.item_a_id = $2 THEN p.item_b_id ELSE p.item_a_id END
       WHERE m.run_id = $1 AND NOT l.private AND base.metadata_path LIKE 'Metadata/Items/Currency/Runegraft%'
       ORDER BY l.name`,
      [snap.runId, snap.quoteItemId],
    );
    const { rows: items } = await pool.query<{ id: number; metadata_path: string }>(
      `SELECT id, metadata_path FROM items WHERE metadata_path LIKE 'Metadata/Items/Currency/Runegraft%'`,
    );
    const itemIds = new Map(items.map((i) => [i.metadata_path, i.id]));

    const runs = [];
    for (const league of leagues) {
      for (const windowHours of WINDOWS) {
        const { asOfHour, prices } = await runegraftPrices(pool, league.name, windowHours);
        // The snapshot can only change under the metrics lock; a different hour means it was replaced meanwhile.
        if (asOfHour !== snap.asOfHour) throw new Error('the Chaos metrics snapshot changed during the Runegraft run');
        if (prices.length === 0) continue;
        const result = expectedValue(weights, prices, { minOutcomePrice });
        const recommended = result.ev === null ? null : recommendedBuyPrice(result.ev, margin);
        runs.push({
          league_id: league.id,
          window_hours: windowHours,
          ev: result.ev,
          ev_is_estimate: result.estimate,
          break_even: result.ev === null ? null : breakEvenBuyPrice(result.ev),
          recommended,
          priced_outcomes: weights.length - result.unpriced.length,
          unknown_outcomes: weights.filter((w) => w.probability === null).length,
          items: prices.map((p) => {
            const itemId = itemIds.get(p.path);
            if (itemId === undefined) throw new Error(`no item row for ${p.path}`);
            return {
              item_id: itemId,
              buy_price: p.buyPriceChaos,
              sell_price: p.sellPriceChaos,
              below_recommended: recommended === null ? null : p.buyPriceChaos < recommended,
              expected_profit:
                result.ev === null ? null : conversionProfit(result.ev, Array(INPUTS_PER_CONVERSION).fill(p.buyPriceChaos)),
            };
          }),
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM runegraft_runs WHERE realm = $1 AND as_of_hour = to_timestamp($2)', [REALM, snap.asOfHour]);
      for (const { items: runItems, ...run } of runs) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO runegraft_runs (realm, league_id, window_hours, as_of_hour, metric_run_id, weights_sha256, margin,
             min_outcome_price, ev, ev_is_estimate, break_even, recommended, priced_outcomes, unknown_outcomes)
           VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [
            REALM,
            run.league_id,
            run.window_hours,
            snap.asOfHour,
            snap.runId,
            sha256,
            margin,
            minOutcomePrice,
            run.ev,
            run.ev_is_estimate,
            run.break_even,
            run.recommended,
            run.priced_outcomes,
            run.unknown_outcomes,
          ],
        );
        await client.query(
          `INSERT INTO runegraft_run_items (run_id, item_id, buy_price, sell_price, below_recommended, expected_profit)
           SELECT $1, x.* FROM jsonb_to_recordset($2::jsonb) AS x(item_id integer, buy_price double precision,
             sell_price double precision, below_recommended boolean, expected_profit double precision)`,
          [inserted.rows[0]!.id, JSON.stringify(runItems)],
        );
        summary.runs++;
        summary.items += runItems.length;
        if (run.recommended !== null) summary.priced++;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    logger.info('Runegraft runs stored', { as_of: hourIso(snap.asOfHour), runs: summary.runs, priced: summary.priced });
    return summary;
  });
}
