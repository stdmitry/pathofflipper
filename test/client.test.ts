import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExchangeClient, exchangeUrl, HttpFailure, rateLimitWaitMs } from '../src/exchange/client.ts';

type Step = Response | Error;

function fakeClient(steps: Step[], options: { maxAttempts?: number; maxDelayMs?: number } = {}) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const client = new ExchangeClient({
    userAgent: 'pathofflipper/test (contact: test)',
    baseUrl: 'https://example.test/api/currency-exchange',
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: 100,
    maxDelayMs: options.maxDelayMs ?? 10_000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      const step = steps.shift();
      if (!step) throw new Error('no more fake responses');
      if (step instanceof Error) throw step;
      return step;
    },
  });
  return { client, requests, sleeps };
}

const ok = (headers: Record<string, string> = {}) =>
  new Response('{"next_change_id":3600,"markets":[]}', { status: 200, headers });

describe('exchangeUrl', () => {
  it('uses the PoE 1 PC format: no realm segment, no cursor for the earliest history', () => {
    const base = 'https://web.poecdn.com/api/currency-exchange';
    assert.equal(exchangeUrl(base, null), base);
    assert.equal(exchangeUrl(base, 7200), `${base}/7200`);
  });
});

describe('ExchangeClient', () => {
  it('sends the identifying user agent and a timeout signal', async () => {
    const { client, requests } = fakeClient([ok()]);
    const response = await client.get(3600);
    assert.equal(response.status, 200);
    assert.equal(requests[0]?.url, 'https://example.test/api/currency-exchange/3600');
    const headers = requests[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['User-Agent'], 'pathofflipper/test (contact: test)');
    assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
  });

  it('retries server errors with exponential backoff', async () => {
    const { client, sleeps } = fakeClient([new Response('', { status: 502 }), new Response('', { status: 503 }), ok()]);
    assert.equal((await client.get(3600)).status, 200);
    assert.deepEqual(sleeps, [100, 200]);
  });

  it('honors Retry-After on 429', async () => {
    const { client, sleeps } = fakeClient([new Response('', { status: 429, headers: { 'Retry-After': '7' } }), ok()]);
    await client.get(3600);
    assert.deepEqual(sleeps, [7000]);
  });

  it('gives up instead of waiting longer than the configured maximum', async () => {
    const { client, sleeps } = fakeClient([new Response('', { status: 429, headers: { 'Retry-After': '3600' } })]);
    await assert.rejects(client.get(3600), /Retry-After of 3600s exceeds/);
    assert.deepEqual(sleeps, []);
  });

  it('retries timeouts a bounded number of times', async () => {
    const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { client, requests } = fakeClient([timeout(), timeout(), timeout()]);
    await assert.rejects(client.get(3600), (error: unknown) => {
      assert.ok(error instanceof HttpFailure);
      assert.match(error.message, /timed out \(gave up after 3 attempts\)/);
      return true;
    });
    assert.equal(requests.length, 3);
  });

  it('does not retry other client errors', async () => {
    const { client, requests } = fakeClient([new Response('bad request', { status: 400 })]);
    await assert.rejects(client.get(3600), (error: unknown) => error instanceof HttpFailure && error.status === 400);
    assert.equal(requests.length, 1);
  });

  it('returns 404 responses for the caller to interpret', async () => {
    const { client } = fakeClient([new Response('{"next_change_id":3600,"markets":[]}', { status: 404 })]);
    assert.equal((await client.get(3600)).status, 404);
  });

  it('pauses before the next request when a rate-limit rule is exhausted', async () => {
    const headers = {
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '10:5:60,30:60:300',
      'X-Rate-Limit-Ip-State': '10:5:0,4:60:0',
    };
    const { client, sleeps } = fakeClient([ok(headers), ok()]);
    await client.get(3600);
    assert.deepEqual(sleeps, []);
    await client.get(7200);
    assert.deepEqual(sleeps, [5000]);
  });
});

describe('rateLimitWaitMs', () => {
  it('waits out an active restriction', () => {
    const headers = new Headers({
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '10:5:60',
      'X-Rate-Limit-Ip-State': '11:5:60',
    });
    assert.equal(rateLimitWaitMs(headers), 60_000);
  });

  it('is zero without rate-limit headers or below the limit', () => {
    assert.equal(rateLimitWaitMs(new Headers()), 0);
    const headers = new Headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '10:5:60', 'X-Rate-Limit-Ip-State': '3:5:0' });
    assert.equal(rateLimitWaitMs(headers), 0);
  });
});
