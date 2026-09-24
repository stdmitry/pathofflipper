import type pg from 'pg';
import { REALM } from './config.ts';
import { HOUR_SECONDS, hourIso } from './exchange/hours.ts';
import { NUMERIC_FIELDS, type NumericField } from './exchange/parse.ts';
import { withMetricsLock } from './ingest.ts';
import { silentLogger, type Logger } from './log.ts';
import {
  CALC_VERSION,
  isEligible,
  rankMarkets,
  rankScore,
  type MarketHour,
  WINDOWS,
  windowMetrics,
  type WindowMetrics,
} from './market/metrics.ts';
import { type Quote, QUOTE_ITEMS } from './market/quotes.ts';
import { classifyHour, quoteHour, type Rational } from './market/semantics.ts';

/** Chaos Orb, the quote currency of the default screen. */
export const CHAOS_PATH = QUOTE_ITEMS.chaos.path;

const LONGEST_WINDOW = Math.max(...WINDOWS);

export interface MetricsOptions {
  /** Newest source hour of the windows (unix seconds); defaults to the newest parsed hour. */
  asOfHour?: number;
  /** Quote currency whose markets to compute (default chaos); each quote has its own snapshot. */
  quote?: Quote;
  logger?: Logger;
}

export interface MetricsSummary {
  /** Null when there is nothing parsed to compute from. */
  asOfHour: number | null;
  /** Hours of the longest window by status of the whole response: parsed, exchange-down (empty) or missing. */
  windowHours: { parsed: number; empty: number; missing: number };
  leagues: number;
  markets: number;
  rows: number;
  eligible: number;
}

interface PairHourRow {
  league_id: number;
  pair_id: number;
  item_a_id: number;
  item_b_id: number;
  hour: string;
  [column: string]: string | number;
}

/**
 * Computes the metrics of every quote-currency market for the 1h, 6h and 24h windows ending at the as-of hour and
 * replaces the stored snapshot of this calculation version in one transaction.
 */
export async function computeMetrics(pool: pg.Pool, options: MetricsOptions = {}): Promise<MetricsSummary> {
  const logger = options.logger ?? silentLogger;
  return withMetricsLock(pool, async () => {
    const quoteItem = QUOTE_ITEMS[options.quote ?? 'chaos'];
    const quote = await pool.query<{ id: number }>('SELECT id FROM items WHERE metadata_path = $1', [quoteItem.path]);
    const quoteId = quote.rows[0]?.id;
    const asOfHour = options.asOfHour ?? (await newestParsedHour(pool));
    const summary: MetricsSummary = {
      asOfHour: asOfHour ?? null,
      windowHours: { parsed: 0, empty: 0, missing: 0 },
      leagues: 0,
      markets: 0,
      rows: 0,
      eligible: 0,
    };
    if (asOfHour === undefined || quoteId === undefined) {
      logger.warn('nothing to compute: no parsed hours or no quote item yet', { quote: options.quote ?? 'chaos' });
      return summary;
    }

    const first = asOfHour - (LONGEST_WINDOW - 1) * HOUR_SECONDS;
    const hours = Array.from({ length: LONGEST_WINDOW }, (_, i) => first + i * HOUR_SECONDS);
    const responseMarkets = await loadResponses(pool, first, asOfHour);
    const leagueMarkets = await loadLeagueMarkets(pool, first, asOfHour);
    const markets = await loadQuoteMarkets(pool, quoteId, first, asOfHour);
    for (const hour of hours) {
      const count = responseMarkets.get(hour);
      if (count === undefined) summary.windowHours.missing++;
      else if (count === 0) summary.windowHours.empty++;
      else summary.windowHours.parsed++;
    }

    const results: { leagueId: number; pairId: number; windowHours: number; metrics: WindowMetrics; rank?: number }[] = [];
    for (const windowHours of WINDOWS) {
      const windowStart = hours.length - windowHours;
      const byLeague = new Map<number, { key: number; sortKey: string; metrics: WindowMetrics }[]>();
      for (const market of markets.values()) {
        const marketHours: MarketHour[] = hours.slice(windowStart).map((hour) => {
          const row = market.rows.get(hour);
          const record = row && toRecord(row);
          const status = classifyHour({
            responseMarkets: responseMarkets.get(hour) ?? null,
            leagueMarkets: leagueMarkets.get(`${market.leagueId}:${hour}`) ?? 0,
            market: record,
          });
          return record ? { status, quoted: quoteHour(record, String(quoteId)) } : { status };
        });
        const list = byLeague.get(market.leagueId) ?? [];
        list.push({ key: market.pairId, sortKey: String(market.pairId), metrics: windowMetrics(marketHours) });
        byLeague.set(market.leagueId, list);
      }
      for (const [leagueId, list] of byLeague) {
        const ranks = rankMarkets(list, quoteItem.minPerHour);
        for (const { key, metrics } of list) {
          results.push({ leagueId, pairId: key, windowHours, metrics, rank: ranks.get(key) });
          if (isEligible(metrics, quoteItem.minPerHour)) summary.eligible++;
        }
      }
    }
    summary.leagues = new Set([...markets.values()].map((m) => m.leagueId)).size;
    summary.markets = markets.size;
    summary.rows = results.length;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM metric_runs WHERE realm = $1 AND quote_item_id = $2 AND calc_version = $3', [
        REALM,
        quoteId,
        CALC_VERSION,
      ]);
      const run = await client.query<{ id: string }>(
        `INSERT INTO metric_runs (realm, quote_item_id, calc_version, as_of_hour)
         VALUES ($1, $2, $3, to_timestamp($4)) RETURNING id`,
        [REALM, quoteId, CALC_VERSION, asOfHour],
      );
      const rows = results.map(({ leagueId, pairId, windowHours, metrics, rank }) => ({
        league_id: leagueId,
        pair_id: pairId,
        window_hours: windowHours,
        covered_hours: metrics.coveredHours,
        traded_hours: metrics.tradedHours,
        base_volume: String(metrics.baseVolume),
        quote_volume: String(metrics.quoteVolume),
        ...fraction('rate', metrics.rate),
        ...fraction('low_rate', metrics.lowRate),
        ...fraction('high_rate', metrics.highRate),
        volatility: metrics.volatility,
        rank_score: rankScore(metrics),
        activity_rank: rank ?? null,
      }));
      await client.query(
        `INSERT INTO market_metrics (run_id, league_id, pair_id, window_hours, covered_hours, traded_hours, base_volume,
           quote_volume, rate_num, rate_den, low_rate_num, low_rate_den, high_rate_num, high_rate_den, volatility,
           rank_score, activity_rank)
         SELECT $1, x.* FROM jsonb_to_recordset($2::jsonb) AS x(league_id integer, pair_id integer,
           window_hours smallint, covered_hours smallint, traded_hours smallint, base_volume bigint, quote_volume bigint,
           rate_num bigint, rate_den bigint, low_rate_num bigint, low_rate_den bigint, high_rate_num bigint,
           high_rate_den bigint, volatility double precision, rank_score double precision, activity_rank integer)`,
        [run.rows[0]!.id, JSON.stringify(rows)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    logger.info('metrics computed', {
      quote: options.quote ?? 'chaos',
      as_of: hourIso(asOfHour),
      calc_version: CALC_VERSION,
      rows: summary.rows,
    });
    return summary;
  });
}

function fraction(prefix: string, value: Rational | null): Record<string, string | null> {
  return { [`${prefix}_num`]: value ? String(value.num) : null, [`${prefix}_den`]: value ? String(value.den) : null };
}

async function newestParsedHour(pool: pg.Pool): Promise<number | undefined> {
  const { rows } = await pool.query<{ hour: string | null }>(
    `SELECT extract(epoch FROM max(source_hour))::bigint AS hour FROM raw_digests
     WHERE realm = $1 AND parser_version IS NOT NULL`,
    [REALM],
  );
  return rows[0]?.hour == null ? undefined : Number(rows[0].hour);
}

/** Market count of each parsed hour. Unparsed hours have no pair_hours yet, so they count as missing. */
async function loadResponses(pool: pg.Pool, first: number, last: number): Promise<Map<number, number>> {
  const { rows } = await pool.query<{ hour: string; market_count: number }>(
    `SELECT extract(epoch FROM source_hour)::bigint AS hour, market_count FROM raw_digests
     WHERE realm = $1 AND parser_version IS NOT NULL AND source_hour BETWEEN to_timestamp($2) AND to_timestamp($3)`,
    [REALM, first, last],
  );
  return new Map(rows.map((row) => [Number(row.hour), row.market_count]));
}

/** Markets per league and hour, keyed `league:hour`, to tell an inactive market from a league that isn't running. */
async function loadLeagueMarkets(pool: pg.Pool, first: number, last: number): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ league_id: number; hour: string; markets: number }>(
    `SELECT h.league_id, extract(epoch FROM h.source_hour)::bigint AS hour, h.markets
     FROM league_hours h JOIN leagues l ON l.id = h.league_id
     WHERE l.realm = $1 AND h.source_hour BETWEEN to_timestamp($2) AND to_timestamp($3)`,
    [REALM, first, last],
  );
  return new Map(rows.map((row) => [`${row.league_id}:${Number(row.hour)}`, row.markets]));
}

interface QuoteMarket {
  leagueId: number;
  pairId: number;
  rows: Map<number, PairHourRow>;
}

/** Every quote-currency market of a public league with at least one row in the window, with its rows by hour. */
async function loadQuoteMarkets(pool: pg.Pool, quoteId: number, first: number, last: number) {
  const columns = NUMERIC_FIELDS.flatMap((field) => [`h.${field}_a`, `h.${field}_b`]).join(', ');
  const { rows } = await pool.query<PairHourRow>(
    // Read the window first: joined up front, the planner probes the primary key once per league and pair.
    `WITH w AS MATERIALIZED (
       SELECT * FROM pair_hours WHERE source_hour BETWEEN to_timestamp($3) AND to_timestamp($4)
     )
     SELECT h.league_id, h.pair_id, p.item_a_id, p.item_b_id, extract(epoch FROM h.source_hour)::bigint AS hour, ${columns}
     FROM w h JOIN pairs p ON p.id = h.pair_id
     WHERE $2 IN (p.item_a_id, p.item_b_id) AND h.league_id IN (SELECT id FROM leagues WHERE realm = $1 AND NOT private)`,
    [REALM, quoteId, first, last],
  );
  const markets = new Map<string, QuoteMarket>();
  for (const row of rows) {
    const key = `${row.league_id}:${row.pair_id}`;
    let market = markets.get(key);
    if (!market) {
      market = { leagueId: row.league_id, pairId: row.pair_id, rows: new Map() };
      markets.set(key, market);
    }
    market.rows.set(Number(row.hour), row);
  }
  return markets;
}

/** A pair_hours row as a MarketRecord keyed by item id. Stored values fit in ±2^53, so Number is exact. */
function toRecord(row: PairHourRow) {
  const values = {} as Record<NumericField, [number, number]>;
  for (const field of NUMERIC_FIELDS) values[field] = [Number(row[`${field}_a`]), Number(row[`${field}_b`])];
  return { pair: [String(row.item_a_id), String(row.item_b_id)] as [string, string], values };
}
