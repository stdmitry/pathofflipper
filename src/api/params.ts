import { REALM } from '../config.ts';
import { WINDOWS, type WindowHours } from '../market/metrics.ts';

/** A request the API refuses with 400, naming the offending parameter. */
export class InvalidParameterError extends Error {
  override name = 'InvalidParameterError';
  readonly parameter: string;

  constructor(parameter: string, message: string) {
    super(message);
    this.parameter = parameter;
  }
}

export const QUOTES = { chaos: 'Metadata/Items/Currency/CurrencyRerollRare' } as const;
export type Quote = keyof typeof QUOTES;

export const MARKET_SORTS = ['rank', 'turnover', 'units', 'persistence', 'volatility', 'rate', 'low', 'high', 'name'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

/** History windows in hours; 30 days bounds a response to 720 points. */
export const HISTORY_WINDOWS = { '24h': 24, '7d': 168, '30d': 720 } as const;

export const MAX_LIMIT = 100;
export const MAX_OFFSET = 10_000;
const MAX_TEXT = 200;

export interface MarketListParams {
  realm: typeof REALM;
  league: string;
  quote: Quote;
  window: WindowHours;
  /** `eligible` (default) lists ranked markets only; `all` includes every market of the snapshot. */
  scope: 'eligible' | 'all';
  sort: MarketSort;
  order: 'asc' | 'desc';
  q: string | undefined;
  limit: number;
  offset: number;
}

export interface HistoryParams {
  realm: typeof REALM;
  league: string;
  quote: Quote;
  windowHours: number;
  window: keyof typeof HISTORY_WINDOWS;
}

/** Reads query parameters, rejecting unknown or repeated ones so that typos fail loudly. */
class Query {
  private readonly params: URLSearchParams;

  constructor(params: URLSearchParams, allowed: readonly string[]) {
    this.params = params;
    for (const key of new Set(params.keys())) {
      if (!allowed.includes(key)) throw new InvalidParameterError(key, `Unknown parameter "${key}"; allowed: ${allowed.join(', ')}`);
      if (params.getAll(key).length > 1) throw new InvalidParameterError(key, `Parameter "${key}" is repeated`);
    }
  }

  text(name: string, required: true): string;
  text(name: string, required?: false): string | undefined;
  text(name: string, required = false): string | undefined {
    const value = this.params.get(name) ?? undefined;
    if (value === undefined || value === '') {
      if (required) throw new InvalidParameterError(name, `Parameter "${name}" is required`);
      return undefined;
    }
    if (value.length > MAX_TEXT) throw new InvalidParameterError(name, `Parameter "${name}" is longer than ${MAX_TEXT} characters`);
    return value;
  }

  oneOf<T extends string>(name: string, choices: readonly T[], fallback: T): T {
    const value = this.text(name);
    if (value === undefined) return fallback;
    if (!(choices as readonly string[]).includes(value)) {
      throw new InvalidParameterError(name, `Parameter "${name}" must be one of ${choices.join(', ')}; got "${value}"`);
    }
    return value as T;
  }

  int(name: string, min: number, max: number, fallback: number): number {
    const value = this.text(name);
    if (value === undefined) return fallback;
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      throw new InvalidParameterError(name, `Parameter "${name}" must be an integer from ${min} to ${max}; got "${value}"`);
    }
    return n;
  }
}

function realm(query: Query): typeof REALM {
  return query.oneOf('realm', [REALM], REALM);
}

export function parseLeaguesParams(params: URLSearchParams): { realm: typeof REALM } {
  return { realm: realm(new Query(params, ['realm'])) };
}

export function parseStatusParams(params: URLSearchParams): { realm: typeof REALM } {
  return { realm: realm(new Query(params, ['realm'])) };
}

export function parseMarketListParams(params: URLSearchParams): MarketListParams {
  const query = new Query(params, ['realm', 'league', 'quote', 'window', 'scope', 'sort', 'order', 'q', 'limit', 'offset']);
  const windowLabels = WINDOWS.map((hours) => `${hours}h`);
  const window = Number(query.oneOf('window', windowLabels, '24h').slice(0, -1)) as WindowHours;
  const sort = query.oneOf('sort', MARKET_SORTS, 'rank');
  // Rank 1 is best and names read A to Z; every other sort shows the largest values first.
  const defaultOrder = sort === 'rank' || sort === 'name' ? 'asc' : 'desc';
  return {
    realm: realm(query),
    league: query.text('league', true),
    quote: query.oneOf('quote', Object.keys(QUOTES) as Quote[], 'chaos'),
    window,
    scope: query.oneOf('scope', ['eligible', 'all'], 'eligible'),
    sort,
    order: query.oneOf('order', ['asc', 'desc'], defaultOrder),
    q: query.text('q'),
    limit: query.int('limit', 1, MAX_LIMIT, 50),
    offset: query.int('offset', 0, MAX_OFFSET, 0),
  };
}

export function parseHistoryParams(params: URLSearchParams): HistoryParams {
  const query = new Query(params, ['realm', 'league', 'quote', 'window']);
  const window = query.oneOf('window', Object.keys(HISTORY_WINDOWS) as (keyof typeof HISTORY_WINDOWS)[], '24h');
  return {
    realm: realm(query),
    league: query.text('league', true),
    quote: query.oneOf('quote', Object.keys(QUOTES) as Quote[], 'chaos'),
    window,
    windowHours: HISTORY_WINDOWS[window],
  };
}

/**
 * Market ids in URLs are opaque to clients: base64url of the base item's Metadata path. Together with the quote they
 * identify the pair, and unlike database ids they survive a rebuild.
 */
export function encodeMarketId(baseItemPath: string): string {
  return Buffer.from(baseItemPath, 'utf8').toString('base64url');
}

/** Returns the base item path, or undefined when the id cannot be one of ours. */
export function decodeMarketId(id: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(id)) return undefined;
  const path = Buffer.from(id, 'base64url').toString('utf8');
  return path.startsWith('Metadata/') && encodeMarketId(path) === id ? path : undefined;
}
