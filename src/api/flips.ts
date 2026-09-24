import type pg from 'pg';
import { REALM } from '../config.ts';
import { type Flip, crossFlip } from '../market/flips.ts';
import { QUOTE_ITEMS } from '../market/quotes.ts';
import { toNumber } from '../market/semantics.ts';
import { encodeMarketId, type FlipListParams, type FlipSort } from './params.ts';
import { itemJson, leagueId, rationalJson, snapshot, snapshotMeta, storedRational } from './queries.ts';

interface FlipRow {
  metadata_path: string;
  display_name: string | null;
  category: string;
  item_fee: number | null;
  c_low_num: string | null;
  c_low_den: string | null;
  c_turnover: string | null;
  c_covered: number;
  c_traded: number;
  c_rank: number | null;
  d_high_num: string | null;
  d_high_den: string | null;
  d_turnover: string | null;
  d_covered: number;
  d_traded: number;
  d_rank: number | null;
}

type Candidate = { row: FlipRow; flip: Flip | null; eligible: boolean; rank: number | null };

const SORT_VALUE: Record<Exclude<FlipSort, 'rank' | 'name'>, (f: Flip) => number | null> = {
  score: (f) => f.score,
  margin: (f) => f.marginChaos,
  margin_pct: (f) => f.marginShare,
  per_gold: (f) => f.chaosPerKgold,
  gold: (f) => f.goldPerFlip,
  turnover: (f) => f.turnoverChaos,
  buy: (f) => f.buyChaos,
  sell: (f) => f.sellChaos,
};

/**
 * Items traded both for Chaos and for Divines in a league, as a Chaos → Divine flip: buy at the Chaos market's low,
 * sell at the Divine market's high, Divines valued at the window's Chaos/Divine rate. Built from the two stored
 * metric snapshots at request time. A flip is eligible when both of its markets are and it has a positive margin and
 * a known gold cost; eligible flips are ranked by score.
 */
export async function listFlips(pool: pg.Pool, params: FlipListParams, now: Date) {
  const league = await leagueId(pool, params.league);
  const [chaosRun, divineRun] = await Promise.all([
    snapshot(pool, QUOTE_ITEMS.chaos.path),
    snapshot(pool, QUOTE_ITEMS.divine.path),
  ]);
  const meta = {
    realm: REALM,
    league: params.league,
    window: `${params.window}h`,
    scope: params.scope,
    sort: params.sort,
    order: params.order,
    limit: params.limit,
    offset: params.offset,
    units: {
      buy: 'Chaos per unit: the lowest price paid in the item’s Chaos market in the window',
      sell: 'Divines per unit: the highest price paid in the item’s Divine market, and that price in Chaos',
      divine_rate: 'Chaos per Divine: volume-weighted rate of the Chaos/Divine market in the window',
      margin: 'Chaos per unit, sell in Chaos minus buy; an upper bound, since both prices are window extremes',
      turnover_per_hour: 'Chaos per covered hour of the slower of the two markets',
      gold_per_flip: 'gold to buy one unit (its fee) and sell it for Divines (Divine fee × Divines wanted)',
      score: 'margin / buy × turnover per hour × Chaos per 1k gold',
    },
    ranking: 'flips eligible in both markets with a positive margin, by score; not a validated profit estimate',
  };
  const empty = (divineRate: number | null) => ({
    data: [],
    meta: { ...meta, divine_rate: divineRate, total: 0, ...snapshotMeta(chaosRun, now) },
  });
  if (!chaosRun || !divineRun) return empty(null);

  const [rate, fee, rows] = await Promise.all([
    pool.query<{ num: string | null; den: string | null }>(
      `SELECT m.rate_num AS num, m.rate_den AS den FROM market_metrics m JOIN pairs p ON p.id = m.pair_id
       WHERE m.run_id = $1 AND m.league_id = $2 AND m.window_hours = $3
         AND $4 IN (p.item_a_id, p.item_b_id) AND $5 IN (p.item_a_id, p.item_b_id)`,
      [chaosRun.runId, league, params.window, chaosRun.quoteItemId, divineRun.quoteItemId],
    ),
    pool.query<{ gold_fee: number | null }>('SELECT gold_fee FROM items WHERE id = $1', [divineRun.quoteItemId]),
    pool.query<FlipRow>(
      `SELECT base.metadata_path, base.display_name, base.category, base.gold_fee AS item_fee,
         c.low_rate_num AS c_low_num, c.low_rate_den AS c_low_den, c.quote_per_hour AS c_turnover,
         c.covered_hours AS c_covered, c.traded_hours AS c_traded, c.activity_rank AS c_rank,
         d.high_rate_num AS d_high_num, d.high_rate_den AS d_high_den, d.quote_per_hour AS d_turnover,
         d.covered_hours AS d_covered, d.traded_hours AS d_traded, d.activity_rank AS d_rank
       FROM market_metrics c
       JOIN pairs pc ON pc.id = c.pair_id
       JOIN items base ON base.id = CASE WHEN pc.item_a_id = $4 THEN pc.item_b_id ELSE pc.item_a_id END
       JOIN pairs pd ON (pd.item_a_id = base.id AND pd.item_b_id = $5) OR (pd.item_a_id = $5 AND pd.item_b_id = base.id)
       JOIN market_metrics d ON d.run_id = $2 AND d.league_id = c.league_id AND d.window_hours = c.window_hours
         AND d.pair_id = pd.id
       WHERE c.run_id = $1 AND c.league_id = $3 AND c.window_hours = $6`,
      [chaosRun.runId, divineRun.runId, league, chaosRun.quoteItemId, divineRun.quoteItemId, params.window],
    ),
  ]);
  const chaosPerDivine = storedRational(rate.rows[0]?.num ?? null, rate.rows[0]?.den ?? null);
  if (!chaosPerDivine) return empty(null);
  const divineRate = toNumber(chaosPerDivine);
  const divineFee = fee.rows[0]?.gold_fee ?? null;

  const candidates: Candidate[] = rows.rows.map((row) => {
    const buyLow = storedRational(row.c_low_num, row.c_low_den);
    const sellHigh = storedRational(row.d_high_num, row.d_high_den);
    const flip =
      buyLow && sellHigh && row.c_turnover !== null && row.d_turnover !== null
        ? crossFlip({
            buyLow,
            sellHigh,
            chaosPerDivine: divineRate,
            chaosTurnover: Number(row.c_turnover),
            divineTurnover: Number(row.d_turnover),
            itemFee: row.item_fee,
            divineFee,
          })
        : null;
    const eligible = row.c_rank !== null && row.d_rank !== null && flip !== null && flip.marginChaos > 0 && flip.score !== null;
    return { row, flip, eligible, rank: null };
  });

  const ranked = candidates
    .filter((c) => c.eligible)
    .sort((x, y) => y.flip!.score! - x.flip!.score! || y.flip!.turnoverChaos - x.flip!.turnoverChaos || byPath(x, y));
  ranked.forEach((c, index) => (c.rank = index + 1));

  const needle = params.q?.toLowerCase();
  const shown = candidates.filter(
    (c) =>
      (params.scope === 'all' || c.eligible) &&
      (!needle || c.row.metadata_path.toLowerCase().includes(needle) || c.row.display_name?.toLowerCase().includes(needle)),
  );
  shown.sort(compareBy(params.sort, params.order));

  return {
    data: shown.slice(params.offset, params.offset + params.limit).map(({ row, flip, eligible, rank }) => ({
      id: encodeMarketId(row.metadata_path),
      item: itemJson(row.metadata_path, row.display_name, row.category),
      rank,
      eligible,
      buy: rationalJson(storedRational(row.c_low_num, row.c_low_den)),
      sell: rationalJson(storedRational(row.d_high_num, row.d_high_den)),
      sell_chaos: flip?.sellChaos ?? null,
      margin_chaos: flip?.marginChaos ?? null,
      margin_share: flip?.marginShare ?? null,
      turnover_per_hour: flip?.turnoverChaos ?? null,
      gold_per_flip: flip?.goldPerFlip ?? null,
      chaos_per_1k_gold: flip?.chaosPerKgold ?? null,
      score: flip?.score ?? null,
      chaos_market: { covered_hours: row.c_covered, traded_hours: row.c_traded, rank: row.c_rank },
      divine_market: { covered_hours: row.d_covered, traded_hours: row.d_traded, rank: row.d_rank },
    })),
    meta: { ...meta, divine_rate: divineRate, gold_fees: { divine: divineFee }, total: shown.length, ...snapshotMeta(chaosRun, now) },
  };
}

function byPath(x: Candidate, y: Candidate): number {
  return x.row.metadata_path < y.row.metadata_path ? -1 : x.row.metadata_path > y.row.metadata_path ? 1 : 0;
}

/** Orders flips by one column; missing values go last in either direction, like NULLS LAST in the market list. */
function compareBy(sort: FlipSort, order: 'asc' | 'desc') {
  const sign = order === 'asc' ? 1 : -1;
  const value = (c: Candidate): number | string | null => {
    if (sort === 'rank') return c.rank;
    if (sort === 'name') return (c.row.display_name ?? c.row.metadata_path).toLowerCase();
    return c.flip ? SORT_VALUE[sort](c.flip) : null;
  };
  return (x: Candidate, y: Candidate): number => {
    const a = value(x);
    const b = value(y);
    if (a === null || b === null) return a === b ? byPath(x, y) : a === null ? 1 : -1;
    return (a < b ? -1 : a > b ? 1 : 0) * sign || byPath(x, y);
  };
}
