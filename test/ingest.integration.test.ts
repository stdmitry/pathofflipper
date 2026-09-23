import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import type { ExchangeResponse, ExchangeSource } from '../src/exchange/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { MalformedResponseError } from '../src/exchange/parse.ts';
import { ingest, readCursor, type IngestOptions } from '../src/ingest.ts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set (see README: Tests)';

const H0 = 1722027600;
const HOUR = 3600;
const FIXTURE_MARKETS = 232;
const fixtureBody = readFileSync(new URL('./fixtures/pc-1722027600.json', import.meta.url), 'utf8');

/** The fixture re-labelled as the response for `cursor`, optionally with raw market JSON prepended. */
function hourBody(cursor: number, extraMarketJson?: string): string {
  let body = fixtureBody.replace(/"next_change_id":\d+/, `"next_change_id":${cursor + HOUR}`);
  if (extraMarketJson) body = body.replace('"markets":[', `"markets":[${extraMarketJson},`);
  return body;
}

/** Serves `hours` published hours starting at H0; later cursors answer like the unpublished current hour. */
class FakeExchange implements ExchangeSource {
  readonly requested: (number | null)[] = [];
  readonly overrides = new Map<number, ExchangeResponse>();
  private readonly hours: number;

  constructor(hours: number) {
    this.hours = hours;
  }

  async get(cursor: number | null): Promise<ExchangeResponse> {
    this.requested.push(cursor);
    const url = `fake/${cursor}`;
    if (cursor === null) return { url, status: 200, body: hourBody(H0 - HOUR) };
    const override = this.overrides.get(cursor);
    if (override) return override;
    if (cursor >= H0 + this.hours * HOUR) {
      return { url, status: 404, body: JSON.stringify({ next_change_id: cursor, markets: [] }) };
    }
    return { url, status: 200, body: hourBody(cursor) };
  }
}

describe('ingest (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;

  const count = async (table: string) =>
    Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

  const options = (overrides: Partial<IngestOptions> = {}): IngestOptions => ({
    maxHours: 10,
    start: { kind: 'hour', cursor: H0 },
    ...overrides,
  });

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE market_hours, raw_digests, ingestion_cursors, rejected_responses RESTART IDENTITY');
  });

  it('stores a bounded batch with raw digests, market rows and the cursor', async () => {
    const exchange = new FakeExchange(5);
    const summary = await ingest(pool, exchange, options({ maxHours: 2 }));

    assert.equal(summary.stopReason, 'limit');
    assert.equal(summary.hoursStored, 2);
    assert.equal(summary.marketsInserted, 2 * FIXTURE_MARKETS);
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR]);
    assert.equal(await readCursor(pool), H0 + 2 * HOUR);
    assert.equal(await count('raw_digests'), 2);
    assert.equal(await count('market_hours'), 2 * FIXTURE_MARKETS);

    const { rows } = await pool.query(
      `SELECT DISTINCT realm, extract(epoch FROM source_hour)::bigint AS source_hour, fetched_at > source_hour + interval '1 hour' AS fetched_later
       FROM market_hours ORDER BY 2`,
    );
    assert.deepEqual(rows, [
      { realm: 'pc', source_hour: String(H0), fetched_later: true },
      { realm: 'pc', source_hour: String(H0 + HOUR), fetched_later: true },
    ]);
    const sample = await pool.query(
      `SELECT league, item_a_id, item_b_id FROM market_hours WHERE market_id = item_a_id || '|' || item_b_id LIMIT 1`,
    );
    assert.equal(sample.rows[0]?.league, 'Settlers');
  });

  it('resumes from the committed cursor and stops when caught up', async () => {
    const exchange = new FakeExchange(3);
    await ingest(pool, exchange, options({ maxHours: 2 }));
    const second = await ingest(pool, exchange, options({ maxHours: 10, start: { kind: 'hour', cursor: H0 + 99 * HOUR } }));

    assert.equal(second.stopReason, 'caught-up');
    assert.equal(second.hoursStored, 1);
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR, H0 + 2 * HOUR, H0 + 3 * HOUR]);
    assert.equal(await readCursor(pool), H0 + 3 * HOUR);
  });

  it('ignores cursors of other realms when bootstrapping and resuming', async () => {
    await pool.query(
      `INSERT INTO ingestion_cursors (realm, next_cursor, last_error, last_error_at)
       VALUES ('xbox', $1, 'old xbox error', now()), ('sony', $2, NULL, NULL)`,
      [H0 + 50 * HOUR, H0 - 10 * HOUR],
    );
    const before = await pool.query(`SELECT * FROM ingestion_cursors WHERE realm <> 'pc' ORDER BY realm`);
    const exchange = new FakeExchange(4);

    // No PC cursor yet: bootstrap from the start point, not from another realm's cursor.
    await ingest(pool, exchange, options({ maxHours: 2 }));
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR]);
    assert.equal(await readCursor(pool), H0 + 2 * HOUR);

    // With a PC cursor: resume from it, still regardless of the other cursors.
    const resumed = await ingest(pool, exchange, options({ maxHours: 10 }));
    assert.equal(resumed.stopReason, 'caught-up');
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR, H0 + 2 * HOUR, H0 + 3 * HOUR, H0 + 4 * HOUR]);
    assert.equal(await readCursor(pool), H0 + 4 * HOUR);

    const after = await pool.query(`SELECT * FROM ingestion_cursors WHERE realm <> 'pc' ORDER BY realm`);
    assert.deepEqual(after.rows, before.rows);
  });

  it('writes digests, markets, rejections and cursor updates only under pc', async () => {
    const exchange = new FakeExchange(3);
    exchange.overrides.set(H0 + 2 * HOUR, { url: 'fake', status: 200, body: '{"next_change_id":1,"markets":[]}' });
    await assert.rejects(ingest(pool, exchange, options()), MalformedResponseError);

    const { rows } = await pool.query(
      `SELECT 'raw_digests' AS source, realm, count(*)::int AS n FROM raw_digests GROUP BY realm
       UNION ALL SELECT 'market_hours', realm, count(*)::int FROM market_hours GROUP BY realm
       UNION ALL SELECT 'rejected_responses', realm, count(*)::int FROM rejected_responses GROUP BY realm
       UNION ALL SELECT 'ingestion_cursors', realm, count(*)::int FROM ingestion_cursors GROUP BY realm
       ORDER BY 1`,
    );
    assert.deepEqual(rows, [
      { source: 'ingestion_cursors', realm: 'pc', n: 1 },
      { source: 'market_hours', realm: 'pc', n: 2 * FIXTURE_MARKETS },
      { source: 'raw_digests', realm: 'pc', n: 2 },
      { source: 'rejected_responses', realm: 'pc', n: 1 },
    ]);
  });

  it('bootstraps from the earliest history when asked', async () => {
    const exchange = new FakeExchange(1);
    await ingest(pool, exchange, options({ maxHours: 1, start: { kind: 'earliest' } }));
    assert.deepEqual(exchange.requested, [null]);
    const { rows } = await pool.query('SELECT request_cursor, extract(epoch FROM source_hour)::bigint AS hour FROM raw_digests');
    assert.deepEqual(rows, [{ request_cursor: null, hour: String(H0 - HOUR) }]);
  });

  it('does not duplicate rows when a batch is replayed', async () => {
    const exchange = new FakeExchange(2);
    await ingest(pool, exchange, options());
    await pool.query('UPDATE ingestion_cursors SET next_cursor = $1', [H0]);

    const replay = await ingest(pool, exchange, options());
    assert.equal(replay.hoursStored, 2);
    assert.equal(replay.marketsInserted, 0);
    assert.equal(replay.marketsAlreadyStored, 2 * FIXTURE_MARKETS);
    assert.equal(await count('market_hours'), 2 * FIXTURE_MARKETS);
    assert.equal(await count('raw_digests'), 2);
  });

  it('keeps numeric values exactly as sent', async () => {
    const a = 'Metadata/Items/Currency/PrecisionTestA';
    const b = 'Metadata/Items/Currency/PrecisionTestB';
    const map = (x: string, y: string) => `{"${a}":${x},"${b}":${y}}`;
    const raw =
      `{"league":"Precision","market_id":"${a}|${b}","market_pair":["${a}","${b}"],` +
      `"volume_traded":${map('123456789012345678901234567890', '0.1234567890123456789')},` +
      `"lowest_stock":${map('0', '1')},"highest_stock":${map('9007199254740993', '2')},` +
      `"lowest_ratio":${map('1', '1')},"highest_ratio":${map('1.50', '2')}}`;
    const exchange = new FakeExchange(1);
    exchange.overrides.set(H0, { url: 'fake', status: 200, body: hourBody(H0, raw) });
    await ingest(pool, exchange, options({ maxHours: 1 }));

    const { rows } = await pool.query(
      `SELECT volume_traded->>item_a_id AS va, volume_traded->>item_b_id AS vb,
              highest_stock->>item_a_id AS hs, highest_ratio->>item_a_id AS hr
       FROM market_hours WHERE league = 'Precision'`,
    );
    assert.deepEqual(rows, [
      { va: '123456789012345678901234567890', vb: '0.1234567890123456789', hs: '9007199254740993', hr: '1.50' },
    ]);
  });

  it('rolls back market rows and the digest when the cursor update fails', async () => {
    await pool.query('ALTER TABLE ingestion_cursors ADD CONSTRAINT test_reject_cursor CHECK (next_cursor < 0)');
    try {
      await assert.rejects(ingest(pool, new FakeExchange(2), options()), /test_reject_cursor/);
    } finally {
      await pool.query('ALTER TABLE ingestion_cursors DROP CONSTRAINT test_reject_cursor');
    }
    assert.equal(await count('market_hours'), 0);
    assert.equal(await count('raw_digests'), 0);
    const { rows } = await pool.query('SELECT next_cursor, last_error FROM ingestion_cursors');
    assert.equal(rows[0]?.next_cursor, null);
    assert.match(rows[0]?.last_error, /test_reject_cursor/);
  });

  it('stops on a malformed response without advancing past it', async () => {
    const exchange = new FakeExchange(5);
    const bad = '{"next_change_id":' + (H0 + 3 * HOUR) + ',"markets":[{"league":"Standard"}]}';
    exchange.overrides.set(H0 + HOUR, { url: 'fake', status: 200, body: bad });

    await assert.rejects(ingest(pool, exchange, options()), MalformedResponseError);
    assert.equal(await readCursor(pool), H0 + HOUR);
    assert.equal(await count('raw_digests'), 1);
    const { rows } = await pool.query('SELECT request_cursor, body, jsonb_array_length(problems) AS problems FROM rejected_responses');
    assert.deepEqual(rows, [{ request_cursor: String(H0 + HOUR), body: bad, problems: 2 }]);

    // A later run retries the same hour rather than skipping it.
    exchange.overrides.clear();
    await ingest(pool, exchange, options());
    assert.equal(exchange.requested.filter((cursor) => cursor === H0 + HOUR).length, 2);
    assert.equal(await readCursor(pool), H0 + 5 * HOUR);
  });

  it('refuses to run while another fetch holds the realm lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7319001, hashtext($1))', ['pc']);
      await assert.rejects(ingest(pool, new FakeExchange(1), options()), /already running/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
    assert.equal(await count('market_hours'), 0);
  });
});
