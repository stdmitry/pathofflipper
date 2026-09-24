import { HOUR_SECONDS } from '../exchange/hours.ts';
import { compareRational, isCovered, type HourStatus, type QuotedHour, type Rational, toNumber, windowRate } from './semantics.ts';

/**
 * Market activity metrics over trailing windows. The definitions, thresholds and their rationale are documented in
 * specs/market-metrics.md. Bump CALC_VERSION whenever a definition or threshold changes.
 */
export const CALC_VERSION = 2;

export const WINDOWS = [1, 6, 24] as const;
export type WindowHours = (typeof WINDOWS)[number];

/** Default screening thresholds, applied to each window. See specs/market-metrics.md for how they were chosen. */
export const ELIGIBILITY = {
  /** Share of the window's hours that must be covered (not missing, exchange-down or league-absent). */
  minCoverage: 0.75,
  /** Share of covered hours that must have trades. */
  minPersistence: 0.5,
  /** Chaos Orbs traded per covered hour; each quote sets its own minimum (src/market/quotes.ts). */
  minQuotePerHour: 100,
} as const;

/** Source data older than this is stale: readers must flag it and keep showing it with its age. */
export const STALE_AFTER_HOURS = 3;

export interface MarketHour {
  status: HourStatus;
  /** Present for `listed` and `traded` hours. */
  quoted?: QuotedHour;
}

export interface WindowMetrics {
  windowHours: number;
  /** Hours that are inactive, listed or traded. Missing, exchange-down and league-absent hours are not covered. */
  coveredHours: number;
  tradedHours: number;
  /** Totals over the window, each on its own side; the two sides are never added together. */
  baseVolume: bigint;
  quoteVolume: bigint;
  /** Volume-weighted rate (quote per base) over the window, null without trades. */
  rate: Rational | null;
  /** Lowest and highest executed rate in the window. Outlier-sensitive, not a spread. */
  lowRate: Rational | null;
  highRate: Rational | null;
  /** Quote-volume-weighted standard deviation of the log hourly rates. Null with fewer than 2 traded hours. */
  volatility: number | null;
}

/** Computes one market's metrics from its hours, oldest first; `hours.length` is the window size. */
export function windowMetrics(hours: MarketHour[]): WindowMetrics {
  let coveredHours = 0;
  let lowRate: Rational | null = null;
  let highRate: Rational | null = null;
  const traded: QuotedHour[] = [];
  for (const hour of hours) {
    if (!isCovered(hour.status)) continue;
    coveredHours++;
    const quoted = hour.quoted;
    if (hour.status !== 'traded' || !quoted?.rate || !quoted.lowRate || !quoted.highRate) continue;
    traded.push(quoted);
    if (!lowRate || compareRational(quoted.lowRate, lowRate) < 0) lowRate = quoted.lowRate;
    if (!highRate || compareRational(quoted.highRate, highRate) > 0) highRate = quoted.highRate;
  }
  const rate = windowRate(traded);
  return {
    windowHours: hours.length,
    coveredHours,
    tradedHours: traded.length,
    baseVolume: traded.reduce((sum, hour) => sum + hour.baseVolume, 0n),
    quoteVolume: traded.reduce((sum, hour) => sum + hour.quoteVolume, 0n),
    rate,
    lowRate,
    highRate,
    volatility: volatility(traded),
  };
}

/**
 * Dispersion of the hourly volume-weighted rates, as the weighted standard deviation of their natural logs with quote
 * volume as the weight. Logs make it independent of orientation and of the price level (0.05 is about ±5%).
 */
function volatility(traded: QuotedHour[]): number | null {
  if (traded.length < 2) return null;
  const points = traded.map((hour) => ({ w: Number(hour.quoteVolume), x: Math.log(toNumber(hour.rate!)) }));
  const total = points.reduce((sum, p) => sum + p.w, 0);
  const mean = points.reduce((sum, p) => sum + p.w * p.x, 0) / total;
  return Math.sqrt(points.reduce((sum, p) => sum + p.w * (p.x - mean) ** 2, 0) / total);
}

export const coverage = (m: WindowMetrics): number => (m.windowHours === 0 ? 0 : m.coveredHours / m.windowHours);

/** Share of covered hours with trades; 0 when nothing is covered. */
export const persistence = (m: WindowMetrics): number => (m.coveredHours === 0 ? 0 : m.tradedHours / m.coveredHours);

/** Quote units traded per covered hour, null when nothing is covered (unknown is not zero). */
export function quotePerHour(m: WindowMetrics): number | null {
  return m.coveredHours === 0 ? null : Number(m.quoteVolume) / m.coveredHours;
}

/** Base units traded per covered hour, null when nothing is covered. */
export function basePerHour(m: WindowMetrics): number | null {
  return m.coveredHours === 0 ? null : Number(m.baseVolume) / m.coveredHours;
}

/**
 * Whether a market passes the default screen, with the minimum turnover in quote units per hour. Staleness is checked
 * by readers, since it depends on read time.
 */
export function isEligible(m: WindowMetrics, minQuotePerHour: number = ELIGIBILITY.minQuotePerHour): boolean {
  return (
    m.rate !== null &&
    coverage(m) >= ELIGIBILITY.minCoverage &&
    persistence(m) >= ELIGIBILITY.minPersistence &&
    (quotePerHour(m) ?? 0) >= minQuotePerHour
  );
}

/**
 * The ranking score: the window's relative price range times its Chaos turnover,
 * (high − low) / low × quote per covered hour. Null without trades or coverage. The range comes from executed trades
 * and is not a spread anyone can capture, so the score orders research candidates; it is not a profit estimate.
 */
export function rankScore(m: WindowMetrics): number | null {
  const turnover = quotePerHour(m);
  if (!m.lowRate || !m.highRate || turnover === null) return null;
  // (h/l) − 1 with h = hn/hd and l = ln/ld, as one exact fraction before converting.
  const num = m.highRate.num * m.lowRate.den - m.lowRate.num * m.highRate.den;
  const den = m.highRate.den * m.lowRate.num;
  return (Number(num) / Number(den)) * turnover;
}

/**
 * Ranks for one league and window: eligible markets by rankScore, highest first, then turnover, then key for a stable
 * order. Ineligible markets get no rank.
 */
export function rankMarkets<K>(
  markets: { key: K; sortKey: string; metrics: WindowMetrics }[],
  minQuotePerHour: number = ELIGIBILITY.minQuotePerHour,
): Map<K, number> {
  const eligible = markets.filter((m) => isEligible(m.metrics, minQuotePerHour));
  eligible.sort(
    (x, y) =>
      (rankScore(y.metrics) ?? 0) - (rankScore(x.metrics) ?? 0) ||
      (quotePerHour(y.metrics) ?? 0) - (quotePerHour(x.metrics) ?? 0) ||
      (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0),
  );
  return new Map(eligible.map((m, index) => [m.key, index + 1]));
}

/** Hours between the end of the newest source hour and `now`. Hour H is complete at H + 1h. */
export function sourceAgeHours(asOfHour: number, now: Date): number {
  return (now.getTime() / 1000 - (asOfHour + HOUR_SECONDS)) / HOUR_SECONDS;
}

export function isStale(asOfHour: number, now: Date): boolean {
  return sourceAgeHours(asOfHour, now) > STALE_AFTER_HOURS;
}
