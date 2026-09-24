import type { MarketRecord } from '../exchange/parse.ts';

/**
 * The normalization contract for exchange market records. The evidence behind each rule is in
 * specs/exchange-api-observations.md ("Field semantics"); `npm run check-semantics` re-checks it against stored data.
 *
 * - volume_traded: both sides of the same executed trades during the hour. volume[a] units of a changed hands for
 *   volume[b] units of b, so the sides are never added together or counted as separate demand.
 * - lowest_ratio / highest_ratio: the extremes of the executed exchange rate, as a reduced fraction
 *   ratio[a] : ratio[b] = units of a per ratio[b] units of b. Both are 0 exactly when nothing traded.
 * - lowest_stock / highest_stock: extremes, in units of each item, of the quantity sitting in unfilled orders,
 *   sampled during the hour. They are not trade liquidity: volume can exceed them and trades can happen with 0 stock.
 */

/** An exact non-negative rational number. */
export interface Rational {
  num: bigint;
  den: bigint;
}

/** One market hour re-oriented so prices read as `quote` units per one `base` unit. */
export interface QuotedHour {
  base: string;
  quote: string;
  /** Units of base and quote that changed hands; both 0 when nothing traded. */
  baseVolume: bigint;
  quoteVolume: bigint;
  /** Volume-weighted executed rate for the hour, null when nothing traded. */
  rate: Rational | null;
  /** Lowest and highest executed rate, null when nothing traded. */
  lowRate: Rational | null;
  highRate: Rational | null;
  /** Sampled unfilled-order quantities in each item's own units. Not trade liquidity. */
  baseStock: { low: bigint; high: bigint };
  quoteStock: { low: bigint; high: bigint };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Builds a reduced rational; throws on a zero denominator rather than inventing a price. */
export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError('rational with a zero denominator');
  if (num < 0n || den < 0n) throw new RangeError('rational must be non-negative');
  const divisor = gcd(num, den) || 1n;
  return { num: num / divisor, den: den / divisor };
}

export function compareRational(x: Rational, y: Rational): number {
  const left = x.num * y.den;
  const right = y.num * x.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Decimal approximation for display only; calculations stay rational. */
export function toNumber(value: Rational): number {
  return Number(value.num) / Number(value.den);
}

/**
 * Re-orients a market so that prices read as `quote` per `base`. Upstream pair order carries no meaning: Chaos Orb is
 * item a in some pairs and item b in others, so every consumer goes through this function instead of reading _a/_b.
 */
export function quoteHour(record: Pick<MarketRecord, 'pair' | 'values'>, quote: string): QuotedHour {
  const [a, b] = record.pair;
  if (quote !== a && quote !== b) throw new RangeError(`${quote} is not an item of the pair ${a}|${b}`);
  const q = quote === a ? 0 : 1;
  const bs = 1 - q;
  const v = record.values;
  const big = (pair: [number, number], side: number) => BigInt(pair[side] as number);

  const quoteVolume = big(v.volume_traded, q);
  const baseVolume = big(v.volume_traded, bs);
  const traded = quoteVolume > 0n && baseVolume > 0n;
  // ratio[quote] : ratio[base] is quote per base. Taking it from the same map keeps lowest <= highest in either
  // orientation: inverting the rates swaps which map holds the minimum, and reading the other side undoes that.
  const low = q === 0 ? v.lowest_ratio : v.highest_ratio;
  const high = q === 0 ? v.highest_ratio : v.lowest_ratio;
  const rateFrom = (pair: [number, number]) => rational(big(pair, q), big(pair, bs));

  return {
    base: q === 0 ? b : a,
    quote,
    baseVolume,
    quoteVolume,
    rate: traded ? rational(quoteVolume, baseVolume) : null,
    lowRate: traded ? rateFrom(low) : null,
    highRate: traded ? rateFrom(high) : null,
    baseStock: { low: big(v.lowest_stock, bs), high: big(v.highest_stock, bs) },
    quoteStock: { low: big(v.lowest_stock, q), high: big(v.highest_stock, q) },
  };
}

/**
 * Volume-weighted rate over several hours: total quote volume over total base volume. Per-hour rates are never
 * averaged. Returns null when nothing traded in the window.
 */
export function windowRate(hours: Pick<QuotedHour, 'baseVolume' | 'quoteVolume'>[]): Rational | null {
  let base = 0n;
  let quote = 0n;
  for (const hour of hours) {
    base += hour.baseVolume;
    quote += hour.quoteVolume;
  }
  return base > 0n && quote > 0n ? rational(quote, base) : null;
}

/**
 * What one market's hour means for activity metrics.
 *
 * - `missing`: no stored response for the hour. Unknown.
 * - `exchange-down`: the response has no markets at all (observed during league launches). Unknown, not inactive.
 * - `league-absent`: the response has markets, but none for this league (before its start or after its end).
 * - `inactive`: the league is present but the market is not; nothing traded or was listed that the API recorded.
 * - `listed`: a record with zero volume; orders may have existed, nothing traded.
 * - `traded`: a record with nonzero volume.
 *
 * Only `inactive`, `listed` and `traded` count as covered hours; the first two count as zero traded volume.
 */
export type HourStatus = 'missing' | 'exchange-down' | 'league-absent' | 'inactive' | 'listed' | 'traded';

export function classifyHour(input: {
  /** Market count of the stored response, or null when the hour was not fetched. */
  responseMarkets: number | null;
  /** Markets of this market's league in the response. */
  leagueMarkets: number;
  market: Pick<MarketRecord, 'values'> | undefined;
}): HourStatus {
  if (input.responseMarkets === null) return 'missing';
  if (input.responseMarkets === 0) return 'exchange-down';
  if (input.leagueMarkets === 0) return 'league-absent';
  if (!input.market) return 'inactive';
  const [a, b] = input.market.values.volume_traded;
  return a > 0 || b > 0 ? 'traded' : 'listed';
}

export function isCovered(status: HourStatus): boolean {
  return status === 'inactive' || status === 'listed' || status === 'traded';
}
