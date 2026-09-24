import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.ts';
import { MalformedResponseError } from '../src/exchange/parse.ts';
import { ingest, readCursor, type IngestOptions } from '../src/ingest.ts';
import {
  count as countRows,
  FakeExchange,
  FIXTURE,
  H0,
  HOUR,
  hourBody,
  marketJson,
  resetSchema,
  skipWithoutDatabase as skip,
  TEST_DATABASE_URL,
} from './support.ts';

const FIXTURE_MARKETS = FIXTURE.markets;

describe('ingest (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;

  const count = (table: string) => countRows(pool, table);

  const options = (overrides: Partial<IngestOptions> = {}): IngestOptions => ({
    maxHours: 10,
    start: { kind: 'hour', cursor: H0 },
    ...overrides,
  });

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE pair_hours, pairs, items, leagues, raw_digests, ingestion_cursors, rejected_responses RESTART IDENTITY CASCADE',
    );
  });

  it('stores a bounded batch of raw digests and the cursor, leaving parsing to parsePending', async () => {
    const exchange = new FakeExchange(5);
    const summary = await ingest(pool, exchange, options({ maxHours: 2 }));

    assert.equal(summary.stopReason, 'limit');
    assert.equal(summary.hoursStored, 2);
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR]);
    assert.equal(await readCursor(pool), H0 + 2 * HOUR);
    const { rows } = await pool.query(
      `SELECT realm, extract(epoch FROM source_hour)::bigint AS source_hour, market_count, parser_version, parse_error
       FROM raw_digests ORDER BY source_hour`,
    );
    const unparsed = { realm: 'pc', market_count: FIXTURE_MARKETS, parser_version: null, parse_error: null };
    assert.deepEqual(rows, [
      { ...unparsed, source_hour: String(H0) },
      { ...unparsed, source_hour: String(H0 + HOUR) },
    ]);
    for (const table of ['pair_hours', 'pairs', 'items', 'leagues']) assert.equal(await count(table), 0, table);
  });

  it('stores an hour whose market records are invalid and moves on', async () => {
    const extra = marketJson('Precision', 'Metadata/Items/Currency/PrecisionA', 'Metadata/Items/Currency/PrecisionB', ['1.50', '2']);
    const exchange = new FakeExchange(3);
    exchange.overrides.set(H0 + HOUR, { url: 'fake', status: 200, body: hourBody(H0 + HOUR, extra) });

    const summary = await ingest(pool, exchange, options());
    assert.equal(summary.stopReason, 'caught-up');
    assert.equal(await readCursor(pool), H0 + 3 * HOUR);
    assert.equal(await count('raw_digests'), 3);
    assert.equal(await count('rejected_responses'), 0);
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

  it('writes digests, rejections and cursor updates only under pc', async () => {
    const exchange = new FakeExchange(3);
    exchange.overrides.set(H0 + 2 * HOUR, { url: 'fake', status: 200, body: '{"next_change_id":1,"markets":[]}' });
    await assert.rejects(ingest(pool, exchange, options()), MalformedResponseError);

    const { rows } = await pool.query(
      `SELECT 'raw_digests' AS source, realm, count(*)::int AS n FROM raw_digests GROUP BY realm
       UNION ALL SELECT 'rejected_responses', realm, count(*)::int FROM rejected_responses GROUP BY realm
       UNION ALL SELECT 'ingestion_cursors', realm, count(*)::int FROM ingestion_cursors GROUP BY realm
       ORDER BY 1`,
    );
    assert.deepEqual(rows, [
      { source: 'ingestion_cursors', realm: 'pc', n: 1 },
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

  it('does not duplicate digests when a batch is replayed', async () => {
    const exchange = new FakeExchange(2);
    await ingest(pool, exchange, options());
    await pool.query('UPDATE ingestion_cursors SET next_cursor = $1', [H0]);

    const replay = await ingest(pool, exchange, options());
    assert.equal(replay.hoursStored, 2);
    assert.equal(await count('raw_digests'), 2);
  });

  it('keeps the stored response when an hour comes back different', async () => {
    const exchange = new FakeExchange(1);
    await ingest(pool, exchange, options());
    await pool.query('UPDATE ingestion_cursors SET next_cursor = $1', [H0]);
    const extra = marketJson('Standard', 'Metadata/Items/Currency/ChangedA', 'Metadata/Items/Currency/ChangedB');
    exchange.overrides.set(H0, { url: 'fake', status: 200, body: hourBody(H0, extra) });

    const replay = await ingest(pool, exchange, options());
    assert.equal(replay.hoursStored, 1);
    const { rows } = await pool.query<{ market_count: number }>('SELECT market_count FROM raw_digests');
    assert.deepEqual(rows, [{ market_count: FIXTURE_MARKETS }]);
  });

  it('rolls back the digest when the cursor update fails', async () => {
    await pool.query('ALTER TABLE ingestion_cursors ADD CONSTRAINT test_reject_cursor CHECK (next_cursor < 0)');
    try {
      await assert.rejects(ingest(pool, new FakeExchange(2), options()), /test_reject_cursor/);
    } finally {
      await pool.query('ALTER TABLE ingestion_cursors DROP CONSTRAINT test_reject_cursor');
    }
    assert.equal(await count('raw_digests'), 0);
    const { rows } = await pool.query('SELECT next_cursor, last_error FROM ingestion_cursors');
    assert.equal(rows[0]?.next_cursor, null);
    assert.match(rows[0]?.last_error, /test_reject_cursor/);
  });

  it('stops on a malformed envelope without advancing past it', async () => {
    const exchange = new FakeExchange(5);
    const bad = '{"next_change_id":' + (H0 + 3 * HOUR + 60) + ',"markets":[]}';
    exchange.overrides.set(H0 + HOUR, { url: 'fake', status: 200, body: bad });

    await assert.rejects(ingest(pool, exchange, options()), MalformedResponseError);
    assert.equal(await readCursor(pool), H0 + HOUR);
    assert.equal(await count('raw_digests'), 1);
    const { rows } = await pool.query('SELECT request_cursor, body, jsonb_array_length(problems) AS problems FROM rejected_responses');
    assert.deepEqual(rows, [{ request_cursor: String(H0 + HOUR), body: bad, problems: 1 }]);

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
    assert.equal(await count('raw_digests'), 0);
  });

  it('runs while a parse holds the parse lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7319002, hashtext($1))', ['pc']);
      const summary = await ingest(pool, new FakeExchange(1), options());
      assert.equal(summary.hoursStored, 1);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });
});
