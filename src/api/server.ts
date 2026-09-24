import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type pg from 'pg';
import { errorMessage, silentLogger, type Logger } from '../log.ts';
import {
  decodeMarketId,
  InvalidParameterError,
  parseHistoryParams,
  parseLeaguesParams,
  parseMarketListParams,
  parseStatusParams,
} from './params.ts';
import { collectorStatus, dataVersion, listLeagues, listMarkets, marketHistory, NotFoundError } from './queries.ts';

export interface ApiOptions {
  logger?: Logger;
  /** Clock for freshness fields; tests pin it. */
  now?: () => Date;
  /** Cached responses kept at most; the whole cache is dropped when committed data changes. */
  cacheEntries?: number;
}

/** The dashboard's static files. */
export const PUBLIC_DIR = path.join(import.meta.dirname, '..', '..', 'public');

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// The dashboard loads only its own files and talks only to this API.
const PAGE_SECURITY = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

type Handler = (url: URL, now: Date) => Promise<unknown>;

type Reply = { status: number; body: string | Buffer; headers: Record<string, string> };

interface Route {
  pattern: RegExp;
  /** Cached until the data version changes; status is cheap and changes with every fetch, so it is not. */
  cached: boolean;
  handler: (match: RegExpMatchArray) => Handler;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * The read API over stored history and metrics. It never calls the exchange: every response comes from PostgreSQL,
 * so load from users does not reach upstream.
 */
export function createApiServer(pool: pg.Pool, options: ApiOptions = {}): http.Server {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const maxEntries = options.cacheEntries ?? 500;
  let cacheVersion = '';
  const cache = new Map<string, { etag: string; body: string }>();

  const routes: Route[] = [
    { pattern: /^\/api\/leagues$/, cached: true, handler: () => (url, at) => (parseLeaguesParams(url.searchParams), listLeagues(pool, at)) },
    { pattern: /^\/api\/markets$/, cached: true, handler: () => (url, at) => listMarkets(pool, parseMarketListParams(url.searchParams), at) },
    {
      pattern: /^\/api\/markets\/([^/]+)\/history$/,
      cached: true,
      handler: (match) => (url, at) => {
        const params = parseHistoryParams(url.searchParams);
        const basePath = decodeMarketId(match[1]!);
        if (!basePath) throw new NotFoundError('Unknown market id');
        return marketHistory(pool, basePath, params, at);
      },
    },
    { pattern: /^\/api\/status$/, cached: false, handler: () => (url, at) => (parseStatusParams(url.searchParams), collectorStatus(pool, at)) },
  ];

  async function respond(req: http.IncomingMessage): Promise<Reply> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'Only GET and HEAD are supported', {});
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.map((r) => ({ r, match: url.pathname.match(r.pattern) })).find((x) => x.match);
    if (!route) {
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', `No endpoint ${url.pathname}`);
      return serveStatic(url.pathname);
    }
    const handler = route.r.handler(route.match!);
    const at = now();

    if (!route.r.cached) {
      return { status: 200, body: JSON.stringify(await handler(url, at)), headers: { 'Cache-Control': 'no-store' } };
    }

    const version = await dataVersion(pool);
    if (version !== cacheVersion) {
      cache.clear();
      cacheVersion = version;
    }
    // Parameters in a stable order, so equivalent URLs share an entry.
    const key = `${url.pathname}?${[...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')}`;
    let entry = cache.get(key);
    if (!entry) {
      const body = JSON.stringify(await handler(url, at));
      entry = { etag: `"${createHash('sha256').update(version).update(body).digest('base64url').slice(0, 27)}"`, body };
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
      cache.set(key, entry);
    }
    const headers = { ETag: entry.etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === entry.etag) return { status: 304, body: '', headers };
    return { status: 200, body: entry.body, headers };
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    respond(req)
      .catch((error: unknown) => {
        const failure = toHttpError(error);
        if (failure.status >= 500) logger.error('request failed', { url: req.url, error: errorMessage(error) });
        return {
          status: failure.status,
          body: JSON.stringify({ error: { code: failure.code, message: failure.message, ...failure.extra } }),
          headers: failure.status === 405 ? { Allow: 'GET, HEAD' } : ({} as Record<string, string>),
        };
      })
      .then(({ status, body, headers }) => {
        res.writeHead(status, {
          ...headers,
          ...(status === 304
            ? {}
            : { 'Content-Type': 'application/json; charset=utf-8', ...headers, 'Content-Length': String(Buffer.byteLength(body)) }),
        });
        res.end(req.method === 'HEAD' || status === 304 ? undefined : body);
        logger.info('request', { method: req.method, url: req.url, status, ms: Date.now() - started });
      });
  });
}

/**
 * Serves a file below PUBLIC_DIR: `/` is the dashboard, other paths map to files with a known type. Anything that
 * resolves outside the directory, or has another type, is not found.
 */
async function serveStatic(pathname: string): Promise<Reply> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  const file = path.resolve(PUBLIC_DIR, `.${relative}`);
  const type = STATIC_TYPES[path.extname(file)];
  if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || relative.includes('\0')) {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  // Vendored libraries live in versioned directories and never change; the app's own files are revalidated.
  const cache = relative.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  return { status: 200, body, headers: { 'Content-Type': type, 'Cache-Control': cache, ...PAGE_SECURITY } };
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof InvalidParameterError) return new HttpError(400, 'invalid_parameter', error.message, { parameter: error.parameter });
  if (error instanceof NotFoundError) return new HttpError(404, 'not_found', error.message);
  // Connection failures mean the database is down: a temporary condition, not a bug.
  const code = (error as { code?: string }).code;
  if (code === 'ECONNREFUSED' || code === '57P01' || code === '57P03' || code === '53300') {
    return new HttpError(503, 'unavailable', 'The database is unavailable; try again shortly');
  }
  return new HttpError(500, 'internal', 'Internal error');
}
