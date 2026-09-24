import type pg from 'pg';

/**
 * Properties of stored pair_hours that the normalization contract in src/market/semantics.ts relies on. Each query
 * counts violating rows; every count must be 0. Products are taken as numeric, since bigint * bigint can overflow.
 */
export const INVARIANTS = [
  {
    name: 'volume_both_sides',
    description: 'volume_traded is zero on both sides or on neither (both sides of the same trades)',
    violation: '(volume_traded_a = 0) <> (volume_traded_b = 0)',
  },
  {
    name: 'ratio_iff_traded',
    description: 'ratios are all zero when nothing traded and all nonzero when something did',
    violation: `CASE WHEN volume_traded_a = 0
      THEN lowest_ratio_a <> 0 OR lowest_ratio_b <> 0 OR highest_ratio_a <> 0 OR highest_ratio_b <> 0
      ELSE lowest_ratio_a = 0 OR lowest_ratio_b = 0 OR highest_ratio_a = 0 OR highest_ratio_b = 0 END`,
  },
  {
    name: 'ratio_reduced',
    description: 'ratios are reduced fractions',
    violation: 'volume_traded_a > 0 AND (gcd(lowest_ratio_a, lowest_ratio_b) > 1 OR gcd(highest_ratio_a, highest_ratio_b) > 1)',
  },
  {
    name: 'ratio_ordered',
    description: 'lowest_ratio a/b <= highest_ratio a/b',
    violation: 'volume_traded_a > 0 AND lowest_ratio_a::numeric * highest_ratio_b > highest_ratio_a::numeric * lowest_ratio_b',
  },
  {
    name: 'volume_rate_within_extremes',
    description: 'volume_traded a/b lies between lowest_ratio and highest_ratio',
    violation: `volume_traded_a > 0 AND (
      volume_traded_a::numeric * lowest_ratio_b < lowest_ratio_a::numeric * volume_traded_b
      OR volume_traded_a::numeric * highest_ratio_b > highest_ratio_a::numeric * volume_traded_b)`,
  },
  {
    name: 'stock_ordered',
    description: 'lowest_stock <= highest_stock on each side',
    violation: 'lowest_stock_a > highest_stock_a OR lowest_stock_b > highest_stock_b',
  },
  {
    name: 'non_negative',
    description: 'no value is negative',
    violation: `least(volume_traded_a, volume_traded_b, lowest_stock_a, lowest_stock_b, highest_stock_a, highest_stock_b,
      lowest_ratio_a, lowest_ratio_b, highest_ratio_a, highest_ratio_b) < 0`,
  },
] as const;

export interface InvariantResult {
  name: string;
  description: string;
  violations: number;
}

export interface SemanticsReport {
  rows: number;
  results: InvariantResult[];
}

/** Counts violations of every invariant in one scan, optionally for one league. */
export async function checkSemantics(pool: pg.Pool, league?: string): Promise<SemanticsReport> {
  const columns = INVARIANTS.map((inv) => `count(*) FILTER (WHERE ${inv.violation}) AS ${inv.name}`).join(',\n');
  const where = league === undefined ? '' : 'WHERE league_id IN (SELECT id FROM leagues WHERE realm = $1 AND name = $2)';
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT count(*) AS total_rows, ${columns} FROM pair_hours ${where}`,
    league === undefined ? [] : ['pc', league],
  );
  const row = rows[0] ?? {};
  return {
    rows: Number(row.total_rows ?? 0),
    results: INVARIANTS.map((inv) => ({ name: inv.name, description: inv.description, violations: Number(row[inv.name]) })),
  };
}
