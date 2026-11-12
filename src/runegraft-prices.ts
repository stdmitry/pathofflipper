import type pg from 'pg';
import { snapshot, storedRational } from './api/queries.ts';
import { itemLabel } from './items.ts';
import type { WindowHours } from './market/metrics.ts';
import { QUOTE_ITEMS } from './market/quotes.ts';
import type { RunegraftPrice } from './market/runegraft.ts';
import { toNumber } from './market/semantics.ts';

export interface RunegraftPrices {
  /** Newest source hour of the Chaos snapshot, or null when metrics have not been computed. */
  asOfHour: number | null;
  /** Runegrafts that traded for Chaos in the window. Markets without a trade have no price and are left out. */
  prices: RunegraftPrice[];
}

/**
 * Reads Runegraft Chaos prices from the stored Chaos metrics snapshot, the same data the dashboard shows. Every
 * Runegraft market of the league is included, eligible for the ranking or not. Run `npm run metrics` first.
 */
export async function runegraftPrices(pool: pg.Pool, leagueName: string, windowHours: WindowHours): Promise<RunegraftPrices> {
  const snap = await snapshot(pool, QUOTE_ITEMS.chaos.path);
  if (!snap) return { asOfHour: null, prices: [] };
  const { rows } = await pool.query<{
    metadata_path: string;
    display_name: string | null;
    rate_num: string;
    rate_den: string;
    low_rate_num: string;
    low_rate_den: string;
  }>(
    `SELECT base.metadata_path, base.display_name, m.rate_num, m.rate_den, m.low_rate_num, m.low_rate_den
     FROM market_metrics m
     JOIN leagues l ON l.id = m.league_id
     JOIN pairs p ON p.id = m.pair_id
     JOIN items base ON base.id = CASE WHEN p.item_a_id = $3 THEN p.item_b_id ELSE p.item_a_id END
     WHERE m.run_id = $1 AND l.name = $2 AND NOT l.private AND m.window_hours = $4
       AND base.metadata_path LIKE 'Metadata/Items/Currency/Runegraft%' AND m.rate_num IS NOT NULL
     ORDER BY base.metadata_path`,
    [snap.runId, leagueName, snap.quoteItemId, windowHours],
  );
  return {
    asOfHour: snap.asOfHour,
    prices: rows.map((row) => ({
      name: itemLabel(row.metadata_path, row.display_name),
      path: row.metadata_path,
      buyPriceChaos: toNumber(storedRational(row.low_rate_num, row.low_rate_den)!),
      sellPriceChaos: toNumber(storedRational(row.rate_num, row.rate_den)!),
      availableQuantity: null,
    })),
  };
}
