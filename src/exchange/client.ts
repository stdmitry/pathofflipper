import { silentLogger, type Logger } from '../log.ts';

export const EXCHANGE_BASE_URL = 'https://web.poecdn.com/api/currency-exchange';

export interface ExchangeResponse {
  url: string;
  status: number;
  body: string;
}

export interface ExchangeSource {
  /** Fetches the PoE 1 PC page for `cursor`, or the earliest history when it is null. */
  get(cursor: number | null): Promise<ExchangeResponse>;
}

export interface ExchangeClientOptions {
  userAgent: string;
  baseUrl?: string;
  /** Per-attempt limit covering the whole request, including reading the body. */
  timeoutMs?: number;
  /** Total attempts for timeouts, network errors, HTTP 429 and HTTP 5xx. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Longest single wait we accept (backoff, Retry-After, or rate-limit penalty) before giving up. */
  maxDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
}

export class HttpFailure extends Error {
  override name = 'HttpFailure';
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export function exchangeUrl(baseUrl: string, cursor: number | null): string {
  // PoE 1 PC is the API's default realm and has no path segment; `/pc/...` returns 404.
  return cursor === null ? baseUrl : `${baseUrl}/${cursor}`;
}

/** Parses Retry-After (seconds or an HTTP date) into milliseconds from now. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

function parseTriples(header: string | null): number[][] {
  if (!header) return [];
  return header.split(',').map((part) => part.split(':').map(Number));
}

/**
 * How long to wait before the next request according to GGG rate-limit headers
 * (https://www.pathofexile.com/developer/docs#ratelimits). Each rule lists `hits:period:penalty`
 * limits and a matching `-State` header with `hits:period:active-restriction` values.
 */
export function rateLimitWaitMs(headers: Headers): number {
  let wait = 0;
  for (const rule of (headers.get('x-rate-limit-rules') ?? '').split(',')) {
    const name = rule.trim().toLowerCase();
    if (!name) continue;
    const limits = parseTriples(headers.get(`x-rate-limit-${name}`));
    const states = parseTriples(headers.get(`x-rate-limit-${name}-state`));
    states.forEach(([hits = 0, , restrictedSeconds = 0], index) => {
      const [maxHits, periodSeconds = 0] = limits[index] ?? [];
      if (restrictedSeconds > 0) wait = Math.max(wait, restrictedSeconds * 1000);
      else if (maxHits !== undefined && hits >= maxHits) wait = Math.max(wait, periodSeconds * 1000);
    });
  }
  return wait;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timed out';
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

export class ExchangeClient implements ExchangeSource {
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private notBefore = 0;

  constructor(options: ExchangeClientOptions) {
    this.userAgent = options.userAgent;
    this.baseUrl = options.baseUrl ?? EXCHANGE_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Fetches one page. Returns 2xx and 404 responses for the caller to interpret; retries transient
   * failures; throws HttpFailure for other client errors or when retries are exhausted.
   */
  async get(cursor: number | null): Promise<ExchangeResponse> {
    const url = exchangeUrl(this.baseUrl, cursor);
    for (let attempt = 1; ; attempt++) {
      await this.waitForRateLimit();

      let status: number;
      let headers: Headers;
      let body: string;
      try {
        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = response.status;
        headers = response.headers;
        body = await response.text();
      } catch (error) {
        const reason = describeError(error);
        await this.retryOrThrow(attempt, `GET ${url} failed: ${reason}`, undefined, undefined, error);
        continue;
      }

      const wait = rateLimitWaitMs(headers);
      if (wait > 0) {
        this.notBefore = Math.max(this.notBefore, this.now() + wait);
        this.logger.warn('rate limit reached; pausing before the next request', { wait_ms: wait });
      }

      if (status === 429 || status >= 500) {
        const retryAfter = parseRetryAfter(headers.get('retry-after'), this.now());
        await this.retryOrThrow(attempt, `GET ${url} returned HTTP ${status}`, retryAfter, status);
        continue;
      }
      if (status >= 400 && status !== 404) {
        throw new HttpFailure(`GET ${url} returned HTTP ${status}: ${body.slice(0, 200)}`, status);
      }
      return { url, status, body };
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const wait = this.notBefore - this.now();
    if (wait <= 0) return;
    if (wait > this.maxDelayMs) {
      throw new HttpFailure(`Rate limited for another ${Math.ceil(wait / 1000)}s; try again later`, 429);
    }
    await this.sleep(wait);
  }

  private async retryOrThrow(
    attempt: number,
    reason: string,
    retryAfterMs: number | undefined,
    status?: number,
    cause?: unknown,
  ): Promise<void> {
    if (attempt >= this.maxAttempts) {
      throw new HttpFailure(`${reason} (gave up after ${attempt} attempts)`, status, { cause });
    }
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const delay = retryAfterMs ?? backoff;
    if (delay > this.maxDelayMs) {
      throw new HttpFailure(
        `${reason}; Retry-After of ${Math.ceil(delay / 1000)}s exceeds the ${this.maxDelayMs / 1000}s limit`,
        status,
        { cause },
      );
    }
    this.logger.warn('request failed; retrying', { reason, attempt, max_attempts: this.maxAttempts, delay_ms: delay });
    await this.sleep(delay);
  }
}
