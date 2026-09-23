import { createHash } from 'node:crypto';
import { HOUR_SECONDS, hourIso, isHourCursor } from './hours.ts';

/** Bump when validation or normalization rules change; stored on every raw digest. */
export const PARSER_VERSION = 1;

export const NUMERIC_FIELDS = [
  'volume_traded',
  'lowest_stock',
  'highest_stock',
  'lowest_ratio',
  'highest_ratio',
] as const;

const MAX_PROBLEMS = 20;

/** The response did not match the documented structure. Nothing from it may be stored. */
export class MalformedResponseError extends Error {
  override name = 'MalformedResponseError';
  readonly problems: string[];

  constructor(summary: string, problems: string[]) {
    const shown = problems.slice(0, 3).join('; ');
    const more = problems.length > 3 ? ` (+${problems.length - 3} more)` : '';
    super(`${summary}: ${shown}${more}`);
    this.problems = problems;
  }
}

/** The API answered with an explicit error (for example, an unknown cursor). */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
}

export type Interpretation =
  | {
      kind: 'hour';
      /** The hour the data describes (unix seconds). */
      sourceHour: number;
      nextCursor: number;
      marketCount: number;
      /** Markets with nonzero traded volume on either side. */
      activeMarketCount: number;
      /** Hours between the requested cursor and the next one that the API skipped over. */
      skippedHours: number;
    }
  | { kind: 'caught-up'; nextCursor: number };

export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates an exchange response and decides what it means for the cursor.
 *
 * `requestCursor` is the cursor that was requested, or null when requesting the earliest history.
 * Field meanings are not interpreted here: numeric maps are only checked for shape.
 */
export function interpretResponse(status: number, body: string, requestCursor: number | null): Interpretation {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new MalformedResponseError(`HTTP ${status} body is not valid JSON`, [
      `body starts with ${JSON.stringify(body.slice(0, 80))}`,
    ]);
  }
  if (!isObject(data)) throw new MalformedResponseError(`HTTP ${status} body is not a JSON object`, []);

  const next = data.next_change_id;
  const markets = data.markets;

  if (status === 404) {
    if (isObject(data.error)) {
      const where = requestCursor === null ? 'the earliest history' : `cursor ${requestCursor}`;
      throw new UpstreamError(`Exchange API returned 404 for ${where}: ${String(data.error.message ?? 'no message')}`);
    }
    // The hour at the cursor has not been published yet.
    if (requestCursor !== null && next === requestCursor && Array.isArray(markets) && markets.length === 0) {
      return { kind: 'caught-up', nextCursor: next };
    }
    throw new MalformedResponseError('Unexpected 404 response', [`body starts with ${JSON.stringify(body.slice(0, 80))}`]);
  }
  if (status !== 200) throw new UpstreamError(`Exchange API returned unexpected HTTP ${status}`);

  if (!isHourCursor(next)) {
    throw new MalformedResponseError('Invalid response', [
      `next_change_id must be an hour-aligned unix timestamp, got ${JSON.stringify(next)}`,
    ]);
  }
  if (!Array.isArray(markets)) throw new MalformedResponseError('Invalid response', ['markets must be an array']);

  if (requestCursor !== null) {
    if (next === requestCursor) {
      if (markets.length === 0) return { kind: 'caught-up', nextCursor: next };
      throw new MalformedResponseError('Invalid response', [
        'next_change_id equals the requested cursor but markets is not empty',
      ]);
    }
    if (next < requestCursor) {
      throw new MalformedResponseError('Invalid response', [
        `next_change_id ${hourIso(next)} is before the requested hour ${hourIso(requestCursor)}`,
      ]);
    }
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  let activeMarketCount = 0;
  markets.forEach((market, index) => {
    if (problems.length >= MAX_PROBLEMS) return;
    if (validateMarket(market, `markets[${index}]`, seen, problems)) activeMarketCount++;
  });
  if (problems.length > 0) throw new MalformedResponseError(`Invalid market records`, problems);

  const sourceHour = requestCursor ?? next - HOUR_SECONDS;
  return {
    kind: 'hour',
    sourceHour,
    nextCursor: next,
    marketCount: markets.length,
    activeMarketCount,
    skippedHours: (next - sourceHour) / HOUR_SECONDS - 1,
  };
}

/** Records structural problems and returns whether the market had nonzero traded volume. */
function validateMarket(market: unknown, where: string, seen: Set<string>, problems: string[]): boolean {
  if (!isObject(market)) {
    problems.push(`${where} is not an object`);
    return false;
  }
  const { league, market_id: marketId, market_pair: pair } = market;
  if (!isNonEmptyString(league)) problems.push(`${where}.league must be a non-empty string`);
  if (!isNonEmptyString(marketId)) problems.push(`${where}.market_id must be a non-empty string`);
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isNonEmptyString) || pair[0] === pair[1]) {
    problems.push(`${where}.market_pair must be two different item ids`);
    return false;
  }

  const key = JSON.stringify([league, marketId]);
  if (seen.has(key)) problems.push(`${where} duplicates league ${String(league)} market ${String(marketId)}`);
  seen.add(key);

  let active = false;
  for (const field of NUMERIC_FIELDS) {
    const values = market[field];
    if (!isObject(values)) {
      problems.push(`${where}.${field} must be an object`);
      continue;
    }
    if (Object.keys(values).length !== 2 || !pair.every((item) => Object.hasOwn(values, item))) {
      problems.push(`${where}.${field} must have exactly the market_pair item ids as keys`);
      continue;
    }
    for (const item of pair) {
      const value = values[item];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${where}.${field}[${item}] must be a number, got ${JSON.stringify(value)}`);
      } else if (field === 'volume_traded' && value !== 0) {
        active = true;
      }
    }
  }
  return active;
}
