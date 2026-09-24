import { createHash } from 'node:crypto';
import { HOUR_SECONDS, hourIso, isHourCursor } from './hours.ts';

/** Bump when validation or normalization rules change; stored on each raw digest once it is parsed into pair_hours. */
export const PARSER_VERSION = 2;

export const NUMERIC_FIELDS = [
  'volume_traded',
  'lowest_stock',
  'highest_stock',
  'lowest_ratio',
  'highest_ratio',
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];

/** One validated market; values are stored as bigint, so they must be exact integers. */
export interface MarketRecord {
  league: string;
  /** market_pair in upstream order. No buy/sell meaning is implied. */
  pair: [string, string];
  /** For each field, the values keyed by pair[0] and pair[1]. */
  values: Record<NumericField, [number, number]>;
}

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

function parseObject(status: number, body: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new MalformedResponseError(`HTTP ${status} body is not valid JSON`, [
      `body starts with ${JSON.stringify(body.slice(0, 80))}`,
    ]);
  }
  if (!isObject(data)) throw new MalformedResponseError(`HTTP ${status} body is not a JSON object`, []);
  return data;
}

/**
 * Checks what fetching needs to move the cursor safely and decides what the response means for it. Market records are
 * not looked at beyond `markets` being an array; parseMarkets validates them later from the stored digest.
 *
 * `requestCursor` is the cursor that was requested, or null when requesting the earliest history.
 */
export function interpretEnvelope(status: number, body: string, requestCursor: number | null): Interpretation {
  const data = parseObject(status, body);
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

  const sourceHour = requestCursor ?? next - HOUR_SECONDS;
  return {
    kind: 'hour',
    sourceHour,
    nextCursor: next,
    marketCount: markets.length,
    skippedHours: (next - sourceHour) / HOUR_SECONDS - 1,
  };
}

/**
 * Validates every market of a stored hour's payload and returns them in payload order.
 * Field meanings are not interpreted here: numeric maps are only checked for shape.
 */
export function parseMarkets(payload: string): MarketRecord[] {
  const markets = parseObject(200, payload).markets;
  if (!Array.isArray(markets)) throw new MalformedResponseError('Invalid response', ['markets must be an array']);

  const problems: string[] = [];
  const seen = new Set<string>();
  const pairs = new Set<string>();
  const records: MarketRecord[] = [];
  markets.forEach((market, index) => {
    if (problems.length >= MAX_PROBLEMS) return;
    const record = validateMarket(market, `markets[${index}]`, seen, pairs, problems);
    if (record) records.push(record);
  });
  if (problems.length > 0) throw new MalformedResponseError(`Invalid market records`, problems);
  return records;
}

/** Records structural problems and returns the market when it is valid. */
function validateMarket(
  market: unknown,
  where: string,
  seen: Set<string>,
  pairs: Set<string>,
  problems: string[],
): MarketRecord | undefined {
  if (!isObject(market)) {
    problems.push(`${where} is not an object`);
    return undefined;
  }
  const { league, market_id: marketId, market_pair: pair } = market;
  const before = problems.length;
  if (!isNonEmptyString(league)) problems.push(`${where}.league must be a non-empty string`);
  if (!isNonEmptyString(marketId)) problems.push(`${where}.market_id must be a non-empty string`);
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isNonEmptyString) || pair[0] === pair[1]) {
    problems.push(`${where}.market_pair must be two different item ids`);
    return undefined;
  }
  const [a, b] = pair as [string, string];
  // market_id is not stored; it is always rebuilt as item_a|item_b.
  if (isNonEmptyString(marketId) && marketId !== `${a}|${b}`) problems.push(`${where}.market_id must be "${a}|${b}", got ${JSON.stringify(marketId)}`);

  const key = JSON.stringify([league, marketId]);
  if (seen.has(key)) problems.push(`${where} duplicates league ${String(league)} market ${String(marketId)}`);
  seen.add(key);
  // A pair is shared by all leagues and keeps one orientation, so the reverse order may never appear.
  if (pairs.has(JSON.stringify([b, a]))) problems.push(`${where}.market_pair ${a}|${b} also appears in the reverse order`);
  pairs.add(JSON.stringify([a, b]));

  const values = {} as Record<NumericField, [number, number]>;
  for (const field of NUMERIC_FIELDS) {
    const map = market[field];
    if (!isObject(map)) {
      problems.push(`${where}.${field} must be an object`);
      continue;
    }
    if (Object.keys(map).length !== 2 || !Object.hasOwn(map, a) || !Object.hasOwn(map, b)) {
      problems.push(`${where}.${field} must have exactly the market_pair item ids as keys`);
      continue;
    }
    for (const item of [a, b]) {
      // Safe integers survive JSON.parse exactly and fit bigint; fractions or larger values need a schema change.
      if (!Number.isSafeInteger(map[item])) {
        problems.push(`${where}.${field}[${item}] must be an integer within ±2^53, got ${JSON.stringify(map[item])}`);
      }
    }
    values[field] = [map[a] as number, map[b] as number];
  }
  if (problems.length > before) return undefined;
  return { league: league as string, pair: [a, b], values };
}
