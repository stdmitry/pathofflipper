import type pg from 'pg';
import { REALM } from '../config.ts';
import { HOUR_SECONDS, hourIso } from '../exchange/hours.ts';
import { NUMERIC_FIELDS, type NumericField } from '../exchange/parse.ts';
import { itemLabel } from '../items.ts';
import {
  basePerHour,
  CALC_VERSION,
  coverage,
  isStale,
  persistence,
  quotePerHour,
  sourceAgeHours,
  STALE_AFTER_HOURS,
  windowMetrics,
  type WindowMetrics,
} from '../market/metrics.ts';
import { classifyHour, quoteHour, type QuotedHour, type Rational, toNumber } from '../market/semantics.ts';
import { encodeMarketId, type HistoryParams, type MarketListParams, type MarketSort, QUOTES } from './params.ts';

/** The requested league, market or item does not exist: the API answers 404. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** Units of every numeric field, repeated in responses so clients never guess. */
export const UNITS = {
  rate: 'quote units per one base unit, as an exact fraction {num, den} and a decimal value',
  volume: 'item units traded; quote and base are the two sides of the same trades and are never added',
  turnover_per_hour: 'quote units traded per covered hour',
  units_per_hour: 'base units traded per covered hour',
  coverage: 'covered hours / hours in the window',
  persistence: 'hours with trades / covered hours',
  volatility: 'quote-volume-weighted standard deviation of log hourly rates (0.05 is about ±5%)',
  stock: 'sampled quantity in unfilled orders, in units of that item; not trade liquidity',
  source_age_hours: `hours since the newest source hour ended; stale after ${STALE_AFTER_HOURS}`,
} as const;

interface Snapshot {
  runId: string;
  asOfHour: number;
  computedAt: Date;
  calcVersion: number;
  quoteItemId: number;
}

/**
 * Changes whenever a metrics run or a parse commits. Cached responses are keyed by it, so they are dropped as soon as
 * new data is committed.
 */
export async function dataVersion(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ run: string; parsed: string }>(
    `SELECT (SELECT coalesce(max(id), 0) FROM metric_runs) AS run,
            (SELECT coalesce(extract(epoch FROM max(source_hour))::bigint, 0) FROM raw_digests
             WHERE realm = $1 AND parser_version IS NOT NULL) AS parsed`,
    [REALM],
  );
  return `${rows[0]!.run}-${rows[0]!.parsed}`;
}

async function snapshot(pool: pg.Pool, quotePath: string): Promise<Snapshot | undefined> {
  const { rows } = await pool.query<{ id: string; as_of: string; computed_at: Date; calc_version: number; quote_item_id: number }>(
    `SELECT r.id, extract(epoch FROM r.as_of_hour)::bigint AS as_of, r.computed_at, r.calc_version, r.quote_item_id
     FROM metric_runs r JOIN items i ON i.id = r.quote_item_id
     WHERE r.realm = $1 AND i.metadata_path = $2 AND r.calc_version = $3`,
    [REALM, quotePath, CALC_VERSION],
  );
  const row = rows[0];
  return row && {
    runId: row.id,
    asOfHour: Number(row.as_of),
    computedAt: row.computed_at,
    calcVersion: row.calc_version,
    quoteItemId: row.quote_item_id,
  };
}

function freshness(asOfHour: number | undefined, now: Date) {
  if (asOfHour === undefined) return { as_of_hour: null, source_age_hours: null, stale: true };
  return {
    as_of_hour: hourIso(asOfHour),
    source_age_hours: Math.round(sourceAgeHours(asOfHour, now) * 100) / 100,
    stale: isStale(asOfHour, now),
  };
}

function snapshotMeta(snap: Snapshot | undefined, now: Date) {
  return {
    ...freshness(snap?.asOfHour, now),
    computed_at: snap?.computedAt.toISOString() ?? null,
    calc_version: CALC_VERSION,
  };
}

function rationalJson(value: Rational | null) {
  return value && { num: String(value.num), den: String(value.den), value: toNumber(value) };
}

function storedRational(num: string | null, den: string | null): Rational | null {
  return num === null || den === null ? null : { num: BigInt(num), den: BigInt(den) };
}

async function leagueId(pool: pg.Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM leagues WHERE realm = $1 AND name = $2', [REALM, name]);
  if (!rows[0]) throw new NotFoundError(`Unknown league "${name}"`);
  return rows[0].id;
}

// ---- GET /api/leagues ---------------------------------------------------------------------------------------------

export async function listLeagues(pool: pg.Pool, now: Date) {
  const snap = await snapshot(pool, QUOTES.chaos);
  if (!snap) return { data: [], meta: { realm: REALM, ...snapshotMeta(undefined, now) } };
  const { rows } = await pool.query<{ name: string; markets: string; eligible: string; active: boolean }>(
    `SELECT l.name, count(*) AS markets, count(m.activity_rank) AS eligible, bool_or(lh.league_id IS NOT NULL) AS active
     FROM market_metrics m
     JOIN leagues l ON l.id = m.league_id
     LEFT JOIN league_hours lh ON lh.league_id = m.league_id AND lh.source_hour = to_timestamp($2)
     WHERE m.run_id = $1 AND m.window_hours = 24
     GROUP BY l.name
     ORDER BY count(m.activity_rank) DESC, count(*) DESC, l.name`,
    [snap.runId, snap.asOfHour],
  );
  return {
    data: rows.map((row) => ({
      name: row.name,
      // Present in the newest source hour; leagues that ended keep their last 24 hours of metrics.
      active: row.active,
      markets_24h: Number(row.markets),
      eligible_markets_24h: Number(row.eligible),
    })),
    meta: { realm: REALM, quote: 'chaos', ...snapshotMeta(snap, now) },
  };
}

// ---- GET /api/markets ---------------------------------------------------------------------------------------------

const SORT_SQL: Record<MarketSort, string> = {
  rank: 'm.activity_rank',
  turnover: 'm.quote_per_hour',
  units: 'm.base_per_hour',
  persistence: 'm.traded_hours::numeric / nullif(m.covered_hours, 0)',
  volatility: 'm.volatility',
  rate: 'm.rate_num::numeric / m.rate_den',
  name: 'lower(coalesce(base.display_name, base.metadata_path))',
};

interface MetricRow {
  total: string;
  metadata_path: string;
  display_name: string | null;
  category: string;
  window_hours: number;
  covered_hours: number;
  traded_hours: number;
  base_volume: string;
  quote_volume: string;
  rate_num: string | null;
  rate_den: string | null;
  low_rate_num: string | null;
  low_rate_den: string | null;
  high_rate_num: string | null;
  high_rate_den: string | null;
  volatility: number | null;
  activity_rank: number | null;
}

/** The fields shared by a market list row and a history summary. */
function metricsJson(m: WindowMetrics) {
  return {
    window_hours: m.windowHours,
    covered_hours: m.coveredHours,
    traded_hours: m.tradedHours,
    coverage: coverage(m),
    persistence: persistence(m),
    turnover_per_hour: quotePerHour(m),
    units_per_hour: basePerHour(m),
    volume: { quote: String(m.quoteVolume), base: String(m.baseVolume) },
    rate: rationalJson(m.rate),
    low_rate: rationalJson(m.lowRate),
    high_rate: rationalJson(m.highRate),
    volatility: m.volatility,
  };
}

function itemJson(path: string, name: string | null, category: string) {
  return { name: itemLabel(path, name), path, category, named: name !== null };
}

export async function listMarkets(pool: pg.Pool, params: MarketListParams, now: Date) {
  const league = await leagueId(pool, params.league);
  const snap = await snapshot(pool, QUOTES[params.quote]);
  const meta = {
    realm: REALM,
    league: params.league,
    quote: params.quote,
    window: `${params.window}h`,
    scope: params.scope,
    sort: params.sort,
    order: params.order,
    limit: params.limit,
    offset: params.offset,
    units: UNITS,
    ranking: 'market activity by quote turnover; not a profitability ranking',
  };
  if (!snap) return { data: [], meta: { ...meta, total: 0, ...snapshotMeta(undefined, now) } };

  const values: unknown[] = [snap.runId, league, params.window, snap.quoteItemId];
  const filters = ['m.run_id = $1', 'm.league_id = $2', 'm.window_hours = $3'];
  if (params.scope === 'eligible') filters.push('m.activity_rank IS NOT NULL');
  if (params.q !== undefined) {
    values.push(`%${params.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    filters.push(`(base.display_name ILIKE $${values.length} OR base.metadata_path ILIKE $${values.length})`);
  }
  values.push(params.limit, params.offset);
  const { rows } = await pool.query<MetricRow>(
    `SELECT count(*) OVER () AS total, base.metadata_path, base.display_name, base.category, m.window_hours,
       m.covered_hours, m.traded_hours, m.base_volume, m.quote_volume, m.rate_num, m.rate_den, m.low_rate_num,
       m.low_rate_den, m.high_rate_num, m.high_rate_den, m.volatility, m.activity_rank
     FROM market_metrics m
     JOIN pairs p ON p.id = m.pair_id
     JOIN items base ON base.id = CASE WHEN p.item_a_id = $4 THEN p.item_b_id ELSE p.item_a_id END
     WHERE ${filters.join(' AND ')}
     ORDER BY ${SORT_SQL[params.sort]} ${params.order} NULLS LAST, base.metadata_path
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return {
    data: rows.map((row) => ({
      id: encodeMarketId(row.metadata_path),
      item: itemJson(row.metadata_path, row.display_name, row.category),
      rank: row.activity_rank,
      eligible: row.activity_rank !== null,
      ...metricsJson({
        windowHours: row.window_hours,
        coveredHours: row.covered_hours,
        tradedHours: row.traded_hours,
        baseVolume: BigInt(row.base_volume),
        quoteVolume: BigInt(row.quote_volume),
        rate: storedRational(row.rate_num, row.rate_den),
        lowRate: storedRational(row.low_rate_num, row.low_rate_den),
        highRate: storedRational(row.high_rate_num, row.high_rate_den),
        volatility: row.volatility,
      }),
    })),
    meta: { ...meta, total: Number(rows[0]?.total ?? 0), ...snapshotMeta(snap, now) },
  };
}

// ---- GET /api/markets/:id/history -----------------------------------------------------------------------------------

function stockJson(q: QuotedHour) {
  return {
    quote: { low: String(q.quoteStock.low), high: String(q.quoteStock.high) },
    base: { low: String(q.baseStock.low), high: String(q.baseStock.high) },
  };
}

export async function marketHistory(pool: pg.Pool, basePath: string, params: HistoryParams, now: Date) {
  const league = await leagueId(pool, params.league);
  const { rows: found } = await pool.query<{
    pair_id: number;
    item_a_id: number;
    item_b_id: number;
    quote_id: number;
    display_name: string | null;
    category: string;
  }>(
    `SELECT p.id AS pair_id, p.item_a_id, p.item_b_id, q.id AS quote_id, base.display_name, base.category
     FROM items base, items q, pairs p
     WHERE base.metadata_path = $1 AND q.metadata_path = $2
       AND ((p.item_a_id, p.item_b_id) = (base.id, q.id) OR (p.item_a_id, p.item_b_id) = (q.id, base.id))`,
    [basePath, QUOTES[params.quote]],
  );
  const market = found[0];
  if (!market) throw new NotFoundError(`No ${params.quote} market for this id`);

  const { rows: newest } = await pool.query<{ hour: string | null }>(
    `SELECT extract(epoch FROM max(source_hour))::bigint AS hour FROM raw_digests
     WHERE realm = $1 AND parser_version IS NOT NULL`,
    [REALM],
  );
  const meta = {
    realm: REALM,
    league: params.league,
    quote: params.quote,
    window: params.window,
    units: UNITS,
    statuses: {
      missing: 'no parsed response for the hour: unknown',
      'exchange-down': 'the response had no markets at all: unknown',
      'league-absent': 'the league had no markets that hour: unknown for this market',
      inactive: 'the league was present but this market was not: no trades or listings recorded',
      listed: 'a record without trades',
      traded: 'a record with trades',
    },
  };
  const item = itemJson(basePath, market.display_name, market.category);
  const last = newest[0]?.hour == null ? undefined : Number(newest[0].hour);
  if (last === undefined) return { data: { id: encodeMarketId(basePath), item, summary: null, hours: [] }, meta: { ...meta, ...freshness(undefined, now) } };

  const first = last - (params.windowHours - 1) * HOUR_SECONDS;
  const range = [first, last];
  const [responses, leagueHours, rows] = await Promise.all([
    pool.query<{ hour: string; market_count: number }>(
      `SELECT extract(epoch FROM source_hour)::bigint AS hour, market_count FROM raw_digests
       WHERE realm = $1 AND parser_version IS NOT NULL AND source_hour BETWEEN to_timestamp($2) AND to_timestamp($3)`,
      [REALM, ...range],
    ),
    pool.query<{ hour: string; markets: number }>(
      `SELECT extract(epoch FROM source_hour)::bigint AS hour, markets FROM league_hours
       WHERE league_id = $1 AND source_hour BETWEEN to_timestamp($2) AND to_timestamp($3)`,
      [league, ...range],
    ),
    pool.query<Record<string, string>>(
      `SELECT extract(epoch FROM source_hour)::bigint AS hour, ${NUMERIC_FIELDS.flatMap((f) => [`${f}_a`, `${f}_b`]).join(', ')}
       FROM pair_hours WHERE league_id = $1 AND pair_id = $2 AND source_hour BETWEEN to_timestamp($3) AND to_timestamp($4)`,
      [league, market.pair_id, ...range],
    ),
  ]);
  const responseMarkets = new Map(responses.rows.map((r) => [Number(r.hour), r.market_count]));
  const leagueMarkets = new Map(leagueHours.rows.map((r) => [Number(r.hour), r.markets]));
  const records = new Map(
    rows.rows.map((row) => {
      const values = {} as Record<NumericField, [number, number]>;
      for (const f of NUMERIC_FIELDS) values[f] = [Number(row[`${f}_a`]), Number(row[`${f}_b`])];
      return [Number(row.hour), { pair: [String(market.item_a_id), String(market.item_b_id)] as [string, string], values }];
    }),
  );

  const hours = Array.from({ length: params.windowHours }, (_, i) => {
    const hour = first + i * HOUR_SECONDS;
    const record = records.get(hour);
    const status = classifyHour({
      responseMarkets: responseMarkets.get(hour) ?? null,
      leagueMarkets: leagueMarkets.get(hour) ?? 0,
      market: record,
    });
    return { hour, status, quoted: record && quoteHour(record, String(market.quote_id)) };
  });
  return {
    data: {
      id: encodeMarketId(basePath),
      item,
      summary: metricsJson(windowMetrics(hours)),
      hours: hours.map(({ hour, status, quoted }) => ({
        hour: hourIso(hour),
        status,
        volume: quoted ? { quote: String(quoted.quoteVolume), base: String(quoted.baseVolume) } : null,
        rate: rationalJson(quoted?.rate ?? null),
        low_rate: rationalJson(quoted?.lowRate ?? null),
        high_rate: rationalJson(quoted?.highRate ?? null),
        stock: quoted ? stockJson(quoted) : null,
      })),
    },
    meta: { ...meta, ...freshness(last, now) },
  };
}

// ---- GET /api/status ----------------------------------------------------------------------------------------------

export async function collectorStatus(pool: pg.Pool, now: Date) {
  const [cursor, digests, rejected, snap] = await Promise.all([
    pool.query<{ next_cursor: string | null; last_success_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
      'SELECT next_cursor, last_success_at, last_error, last_error_at FROM ingestion_cursors WHERE realm = $1',
      [REALM],
    ),
    pool.query<{ fetched: string | null; parsed: string | null; pending: string; failed: string }>(
      `SELECT extract(epoch FROM max(source_hour))::bigint AS fetched,
              extract(epoch FROM max(source_hour) FILTER (WHERE parser_version IS NOT NULL))::bigint AS parsed,
              count(*) FILTER (WHERE parser_version IS NULL) AS pending,
              count(*) FILTER (WHERE parser_version IS NULL AND parse_error IS NOT NULL) AS failed
       FROM raw_digests WHERE realm = $1`,
      [REALM],
    ),
    pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM rejected_responses WHERE realm = $1 AND fetched_at > $2::timestamptz - interval '24 hours'`,
      [REALM, now],
    ),
    snapshot(pool, QUOTES.chaos),
  ]);
  const c = cursor.rows[0];
  const d = digests.rows[0]!;
  const parsed = d.parsed === null ? undefined : Number(d.parsed);
  let parsedLast24h = 0;
  if (parsed !== undefined) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM raw_digests WHERE realm = $1 AND parser_version IS NOT NULL
       AND source_hour BETWEEN to_timestamp($2) AND to_timestamp($3)`,
      [REALM, parsed - 23 * HOUR_SECONDS, parsed],
    );
    parsedLast24h = Number(rows[0]!.n);
  }

  const source = freshness(parsed, now);
  const problems: string[] = [];
  if (parsed === undefined) problems.push('no_data');
  else if (source.stale) problems.push('stale_source');
  if (c?.last_error_at && (!c.last_success_at || c.last_error_at > c.last_success_at)) problems.push('last_fetch_failed');
  if (Number(d.failed) > 0) problems.push('parse_failures');
  if (Number(rejected.rows[0]!.n) > 0) problems.push('rejected_responses');
  if (!snap || (parsed !== undefined && snap.asOfHour < parsed)) problems.push('metrics_behind');
  if (parsed !== undefined && parsedLast24h < 24) problems.push('gaps_last_24h');

  return {
    data: {
      state: problems.length === 0 ? 'ok' : 'degraded',
      problems,
      source,
      collection: {
        next_cursor_hour: c?.next_cursor == null ? null : hourIso(Number(c.next_cursor)),
        last_success_at: c?.last_success_at?.toISOString() ?? null,
        last_error: c?.last_error ?? null,
        last_error_at: c?.last_error_at?.toISOString() ?? null,
        newest_fetched_hour: d.fetched === null ? null : hourIso(Number(d.fetched)),
        newest_parsed_hour: parsed === undefined ? null : hourIso(parsed),
        pending_parse: Number(d.pending),
        failed_parse: Number(d.failed),
        rejected_responses_24h: Number(rejected.rows[0]!.n),
        parsed_hours_last_24h: parsedLast24h,
      },
      metrics: snap ? { as_of_hour: hourIso(snap.asOfHour), computed_at: snap.computedAt.toISOString(), calc_version: snap.calcVersion } : null,
    },
    meta: { realm: REALM, now: now.toISOString() },
  };
}
