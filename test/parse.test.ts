import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseStart } from '../src/exchange/hours.ts';
import { interpretResponse, MalformedResponseError, UpstreamError } from '../src/exchange/parse.ts';

// Real response for GET /api/currency-exchange/1722027600 (PC, Settlers league era).
const FIXTURE_CURSOR = 1722027600;
const fixtureBody = readFileSync(new URL('./fixtures/pc-1722027600.json', import.meta.url), 'utf8');

const A = 'Metadata/Items/Currency/CurrencyRerollRare';
const B = 'Metadata/Items/Currency/UnknownFutureCurrency';

function market(overrides: Record<string, unknown> = {}) {
  const pair = (values: [number, number]) => ({ [A]: values[0], [B]: values[1] });
  return {
    league: 'Standard',
    market_id: `${A}|${B}`,
    market_pair: [A, B],
    volume_traded: pair([0, 0]),
    lowest_stock: pair([1, 2]),
    highest_stock: pair([3, 4]),
    lowest_ratio: pair([1, 5]),
    highest_ratio: pair([1, 7]),
    ...overrides,
  };
}

function page(nextChangeId: unknown, markets: unknown[]): string {
  return JSON.stringify({ next_change_id: nextChangeId, markets });
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MalformedResponseError, `expected MalformedResponseError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail('expected a MalformedResponseError');
}

describe('interpretResponse', () => {
  it('accepts the real fixture and maps it to the requested hour', () => {
    const result = interpretResponse(200, fixtureBody, FIXTURE_CURSOR);
    const markets = JSON.parse(fixtureBody).markets as { volume_traded: Record<string, number> }[];
    assert.deepEqual(result, {
      kind: 'hour',
      sourceHour: FIXTURE_CURSOR,
      nextCursor: FIXTURE_CURSOR + 3600,
      marketCount: 232,
      activeMarketCount: markets.filter((m) => Object.values(m.volume_traded).some((v) => v !== 0)).length,
      skippedHours: 0,
    });
  });

  it('derives the source hour from next_change_id when requesting the earliest history', () => {
    const result = interpretResponse(200, page(FIXTURE_CURSOR, [market()]), null);
    assert.equal(result.kind, 'hour');
    assert.equal(result.kind === 'hour' && result.sourceHour, FIXTURE_CURSOR - 3600);
  });

  it('accepts an hour with no markets', () => {
    const result = interpretResponse(200, page(FIXTURE_CURSOR + 3600, []), FIXTURE_CURSOR);
    assert.equal(result.kind === 'hour' && result.marketCount, 0);
  });

  it('reports skipped hours when the cursor jumps ahead', () => {
    const result = interpretResponse(200, page(FIXTURE_CURSOR + 3 * 3600, [market()]), FIXTURE_CURSOR);
    assert.equal(result.kind === 'hour' && result.skippedHours, 2);
  });

  it('retains unknown item ids and extra fields', () => {
    const result = interpretResponse(200, page(FIXTURE_CURSOR + 3600, [market({ new_field: true })]), FIXTURE_CURSOR);
    assert.equal(result.kind === 'hour' && result.marketCount, 1);
  });

  it('treats the unpublished current hour (404 with the same cursor) as caught up', () => {
    const body = page(FIXTURE_CURSOR, []);
    assert.deepEqual(interpretResponse(404, body, FIXTURE_CURSOR), { kind: 'caught-up', nextCursor: FIXTURE_CURSOR });
    assert.deepEqual(interpretResponse(200, body, FIXTURE_CURSOR), { kind: 'caught-up', nextCursor: FIXTURE_CURSOR });
  });

  it('rejects an unchanged cursor that still carries markets instead of looping', () => {
    assert.match(problemsOf(() => interpretResponse(200, page(FIXTURE_CURSOR, [market()]), FIXTURE_CURSOR))[0]!, /equals/);
  });

  it('raises UpstreamError for API error bodies', () => {
    const body = JSON.stringify({ error: { code: 1, message: 'Resource not found' } });
    assert.throws(() => interpretResponse(404, body, FIXTURE_CURSOR + 1), UpstreamError);
  });

  it('rejects bodies that are not JSON objects', () => {
    assert.throws(() => interpretResponse(200, '<html>maintenance</html>', FIXTURE_CURSOR), MalformedResponseError);
    assert.throws(() => interpretResponse(200, '[]', FIXTURE_CURSOR), MalformedResponseError);
  });

  it('rejects missing, unaligned, or backwards cursors', () => {
    assert.throws(() => interpretResponse(200, page(undefined, []), FIXTURE_CURSOR), MalformedResponseError);
    assert.throws(() => interpretResponse(200, page(FIXTURE_CURSOR + 60, []), FIXTURE_CURSOR), MalformedResponseError);
    assert.throws(() => interpretResponse(200, page('1722031200', []), FIXTURE_CURSOR), MalformedResponseError);
    assert.throws(() => interpretResponse(200, page(FIXTURE_CURSOR - 3600, []), FIXTURE_CURSOR), MalformedResponseError);
    assert.throws(() => interpretResponse(200, JSON.stringify({ next_change_id: FIXTURE_CURSOR + 3600 }), FIXTURE_CURSOR));
  });

  it('lists every malformed market record', () => {
    const problems = problemsOf(() =>
      interpretResponse(
        200,
        page(FIXTURE_CURSOR + 3600, [
          market({ league: '' }),
          market({ market_pair: [A] }),
          market({ volume_traded: { [A]: '5', [B]: 1 } }),
          market({ league: 'Hardcore', lowest_stock: { [A]: 1 } }),
          market({ league: 'Ruthless', highest_ratio: { [A]: 1, [B]: 2, extra: 3 } }),
          'not a market',
        ]),
        FIXTURE_CURSOR,
      ),
    );
    assert.equal(problems.length, 6);
    assert.match(problems[0]!, /markets\[0\]\.league/);
    assert.match(problems[1]!, /markets\[1\]\.market_pair/);
    assert.match(problems[2]!, /markets\[2\]\.volume_traded.*must be a number/);
    assert.match(problems[3]!, /markets\[3\]\.lowest_stock/);
    assert.match(problems[4]!, /markets\[4\]\.highest_ratio/);
    assert.match(problems[5]!, /markets\[5\] is not an object/);
  });

  it('rejects duplicate league/market pairs', () => {
    const problems = problemsOf(() => interpretResponse(200, page(FIXTURE_CURSOR + 3600, [market(), market()]), FIXTURE_CURSOR));
    assert.match(problems[0]!, /duplicates/);
  });
});

describe('parseStart', () => {
  it('accepts earliest, unix seconds and zoned ISO times on the hour', () => {
    assert.deepEqual(parseStart('earliest'), { kind: 'earliest' });
    assert.deepEqual(parseStart('1722027600'), { kind: 'hour', cursor: 1722027600 });
    assert.deepEqual(parseStart('2024-07-26T21:00Z'), { kind: 'hour', cursor: 1722027600 });
    assert.deepEqual(parseStart('2024-07-26T23:00+02:00'), { kind: 'hour', cursor: 1722027600 });
  });

  it('rejects times off the hour, without a zone, or unparseable', () => {
    assert.throws(() => parseStart('1722027601'), /hour boundary/);
    assert.throws(() => parseStart('2024-07-26T21:30Z'), /hour boundary/);
    assert.throws(() => parseStart('2024-07-26T21:00'), /zone/);
    assert.throws(() => parseStart('yesterday'), /earliest/);
  });
});
