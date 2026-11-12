import type pg from 'pg';
import { REALM } from '../config.ts';
import { listFlips } from '../api/flips.ts';
import { encodeMarketId, type OpportunityListParams, type OpportunitySort } from '../api/params.ts';
import { leagueId, listMarkets } from '../api/queries.ts';
import { QUOTE_ITEMS } from '../market/quotes.ts';
import type { RunegraftWeight } from '../market/runegraft.ts';
import { runegraftPrices } from '../runegraft-prices.ts';
import { flipOpportunity, tradeOpportunity } from './flips.ts';
import { runegraftOpportunities } from './runegraft.ts';
import { type Draft, finish, type FlipRow, type MarketRow, type Opportunity, OPPORTUNITY_KINDS, type OpportunityKind } from './types.ts';

export * from './types.ts';

const UNITS = {
  money: 'Chaos per cycle; Divine legs valued at the window’s volume-weighted Chaos/Divine rate',
  cycle: 'one flip or trade of one unit, or one 3:1 conversion',
  cycles_per_hour: 'cycles the thinnest leg’s traded units per covered hour allow',
  chaos_per_hour_ceiling: 'profit per cycle × cycles per hour: an upper bound, not an expected income',
  gold_per_cycle: 'gold for the orders of one cycle; Runegraft counts the three buy orders only',
  basis:
    'range: from the window’s lowest and highest executed prices (an upper bound); ev: expected value of a random ' +
    'outcome; ev_estimate: expected value from incomplete probabilities or prices',
} as const;

/** Builds every opportunity of a league and window, eligible or not, unranked and unsorted. */
async function build(pool: pg.Pool, params: OpportunityListParams, now: Date, weights: readonly RunegraftWeight[]) {
  const shared = { realm: REALM, league: params.league, window: params.window, scope: 'all', q: undefined, offset: 0 } as const;
  const everything = Number.MAX_SAFE_INTEGER;
  const [chaos, divine, flips, runegrafts, fees] = await Promise.all([
    listMarkets(pool, { ...shared, quote: 'chaos', sort: 'rank', order: 'asc', limit: everything }, now),
    listMarkets(pool, { ...shared, quote: 'divine', sort: 'rank', order: 'asc', limit: everything }, now),
    listFlips(pool, { ...shared, sort: 'rank', order: 'asc', limit: everything }, now),
    runegraftPrices(pool, params.league, params.window),
    pool.query<{ metadata_path: string; gold_fee: number | null }>(
      `SELECT metadata_path, gold_fee FROM items WHERE metadata_path LIKE 'Metadata/Items/Currency/Runegraft%'`,
    ),
  ]);
  const chaosById = new Map((chaos.data as MarketRow[]).map((m) => [m.id, m]));
  const divineById = new Map((divine.data as MarketRow[]).map((m) => [m.id, m]));
  const divineRate: number | null = flips.meta.divine_rate;
  const goldFees = new Map(fees.rows.map((r) => [r.metadata_path, r.gold_fee]));

  const drafts: (Draft | null)[] = [
    ...(chaos.data as MarketRow[]).map((m) => flipOpportunity(m, 'chaos', divineRate)),
    // The Chaos/Divine market is already a Chaos flip (Divine Orb priced in Chaos); its Divine side is the same market.
    ...(divine.data as MarketRow[])
      .filter((m) => m.item.path !== QUOTE_ITEMS.chaos.path)
      .map((m) => flipOpportunity(m, 'divine', divineRate)),
  ];
  if (divineRate !== null) {
    drafts.push(...(flips.data as FlipRow[]).map((f) => tradeOpportunity(f, chaosById.get(f.id), divineById.get(f.id), divineRate)));
  }
  const rg = runegraftOpportunities(
    weights,
    runegrafts.prices,
    (path) => chaosById.get(encodeMarketId(path)),
    (path) => goldFees.get(path) ?? null,
  );
  drafts.push(...rg.drafts);

  const { as_of_hour, source_age_hours, stale, computed_at, calc_version } = chaos.meta;
  return {
    all: drafts.filter((d): d is Draft => d !== null).map(finish),
    divineRate,
    runegraft: rg.summary,
    freshness: { as_of_hour, source_age_hours, stale, computed_at, calc_version },
  };
}

/** Ranks eligible opportunities of every kind by ceiling, highest first; rows without a ceiling rank last. */
export function rank(all: Opportunity[]): void {
  const eligible = all.filter((o) => o.eligible).sort(compareBy('ceiling', 'desc'));
  eligible.forEach((o, index) => (o.rank = index + 1));
}

const SORT_VALUE: Record<OpportunitySort, (o: Opportunity) => number | string | null> = {
  ceiling: (o) => o.chaos_per_hour_ceiling,
  profit: (o) => o.profit_chaos,
  margin_pct: (o) => o.margin_share,
  per_gold: (o) => o.chaos_per_1k_gold,
  cycles: (o) => o.cycles_per_hour,
  name: (o) => o.title.toLowerCase(),
};

/** Orders by one field; missing values go last in either direction, then by id for a stable order. */
export function compareBy(sort: OpportunitySort, order: 'asc' | 'desc') {
  const sign = order === 'asc' ? 1 : -1;
  const byId = (x: Opportunity, y: Opportunity) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  return (x: Opportunity, y: Opportunity): number => {
    const a = SORT_VALUE[sort](x);
    const b = SORT_VALUE[sort](y);
    if (a === null || b === null) return a === b ? byId(x, y) : a === null ? 1 : -1;
    return (a < b ? -1 : a > b ? 1 : 0) * sign || byId(x, y);
  };
}

/**
 * Every kind of opportunity of a league and window in one list (GET /api/opportunities). Built at request time from
 * the stored metric snapshots and the Runegraft weights. The rank and the default order use the Chaos/h ceiling,
 * which is an upper bound, not a profit estimate.
 */
export async function listOpportunities(
  pool: pg.Pool,
  params: OpportunityListParams,
  now: Date,
  weights: readonly RunegraftWeight[],
) {
  await leagueId(pool, params.league);
  const { all, divineRate, runegraft, freshness } = await build(pool, params, now, weights);
  rank(all);

  const needle = params.q?.toLowerCase();
  const matching = all.filter(
    (o) =>
      (params.scope === 'all' || o.eligible) &&
      (params.minProfit === undefined || o.profit_chaos >= params.minProfit) &&
      (!needle || o.title.toLowerCase().includes(needle) || o.item.path.toLowerCase().includes(needle)),
  );
  // Counts ignore the kind filter, so the page can show how many each kind would add.
  const counts = Object.fromEntries(OPPORTUNITY_KINDS.map((k) => [k, matching.filter((o) => o.kind === k).length])) as Record<
    OpportunityKind,
    number
  >;
  const shown = matching.filter((o) => params.kinds.includes(o.kind)).sort(compareBy(params.sort, params.order));

  return {
    data: shown.slice(params.offset, params.offset + params.limit),
    meta: {
      realm: REALM,
      league: params.league,
      window: `${params.window}h`,
      kinds: params.kinds,
      scope: params.scope,
      min_profit: params.minProfit ?? null,
      sort: params.sort,
      order: params.order,
      limit: params.limit,
      offset: params.offset,
      units: UNITS,
      ranking:
        'eligible opportunities of every kind by Chaos/h ceiling = profit per cycle × cycles per hour; an upper bound ' +
        'from past trades, not a validated profit estimate',
      divine_rate: divineRate,
      runegraft,
      counts,
      total: shown.length,
      ...freshness,
    },
  };
}
