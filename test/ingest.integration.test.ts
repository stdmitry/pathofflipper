import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import type { ExchangeResponse, ExchangeSource } from '../src/exchange/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { MalformedResponseError } from '../src/exchange/parse.ts';
import { ingest, readCursor, type IngestOptions } from '../src/ingest.ts';
import {
  count as countRows,
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
      'TRUNCATE pair_hours, pairs, items, leagues, raw_digests, ingestion_cursors, rejected_responses RESTART IDENTITY',
    );
  });

  it('stores a bounded batch with raw digests, dictionaries, pair_hours rows and the cursor', async () => {
    const exchange = new FakeExchange(5);
    const summary = await ingest(pool, exchange, options({ maxHours: 2 }));

    assert.equal(summary.stopReason, 'limit');
    assert.equal(summary.hoursStored, 2);
    assert.equal(summary.marketsInserted, 2 * FIXTURE_MARKETS);
    assert.deepEqual(exchange.requested, [H0, H0 + HOUR]);
    assert.equal(await readCursor(pool), H0 + 2 * HOUR);
    assert.equal(await count('raw_digests'), 2);
    assert.equal(await count('pair_hours'), 2 * FIXTURE_MARKETS);
    assert.equal(await count('leagues'), FIXTURE.leagues);
    assert.equal(await count('items'), FIXTURE.items);
    assert.equal(await count('pairs'), FIXTURE.pairs);

    const { rows } = await pool.query(
      `SELECT DISTINCT l.realm, extract(epoch FROM h.source_hour)::bigint AS source_hour
       FROM pair_hours h JOIN leagues l ON l.id = h.league_id ORDER BY 2`,
    );
    assert.deepEqual(rows, [
      { realm: 'pc', source_hour: String(H0) },
      { realm: 'pc', source_hour: String(H0 + HOUR) },
    ]);

    // Values keep the upstream item order: _a is keyed by market_pair[0] (CurrencyCorrupt), _b by market_pair[1].
    const sample = await pool.query(
      `SELECT h.volume_traded_a, h.volume_traded_b, h.highest_stock_a, h.highest_stock_b, h.lowest_ratio_a, h.lowest_ratio_b
       FROM pair_hours h
       JOIN leagues l ON l.id = h.league_id
       JOIN pairs p ON p.id = h.pair_id
       JOIN items a ON a.id = p.item_a_id
       JOIN items b ON b.id = p.item_b_id
       WHERE l.name = 'Settlers' AND h.source_hour = to_timestamp($1)
         AND a.metadata_path = 'Metadata/Items/Currency/CurrencyCorrupt'
         AND b.metadata_path = 'Metadata/Items/Currency/CurrencyRerollRare'`,
      [H0],
    );
    assert.deepEqual(sample.rows, [
      { volume_traded_a: '2', volume_traded_b: '1', highest_stock_a: '15', highest_stock_b: '0', lowest_ratio_a: '2', lowest_ratio_b: '1' },
    ]);
  });

  it('names items from the item name map and leaves unknown paths unnamed', async () => {
    const itemNames = new Map([
      ['Metadata/Items/Currency/CurrencyRerollRare', 'Chaos Orb'],
      ['Metadata/Items/Currency/CurrencyCorrupt', 'Vaal Orb'],
    ]);
    await ingest(pool, new FakeExchange(1), options({ itemNames }));
    const { rows } = await pool.query(
      `SELECT metadata_path, display_name FROM items WHERE display_name IS NOT NULL ORDER BY metadata_path`,
    );
    assert.deepEqual(rows, [
      { metadata_path: 'Metadata/Items/Currency/CurrencyCorrupt', display_name: 'Vaal Orb' },
      { metadata_path: 'Metadata/Items/Currency/CurrencyRerollRare', display_name: 'Chaos Orb' },
    ]);

    // A later snapshot can add a name; a path missing from it keeps its stored name.
    await pool.query('UPDATE ingestion_cursors SET next_cursor = $1', [H0]);
    await ingest(pool, new FakeExchange(1), options({ itemNames: new Map([['Metadata/Items/Currency/CurrencyCorrupt', 'Vaal']]) }));
    const renamed = await pool.query(`SELECT count(*)::int AS n FROM items WHERE display_name IN ('Vaal', 'Chaos Orb')`);
    assert.equal(renamed.rows[0]?.n, 2);
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
       UNION ALL SELECT 'pair_hours', l.realm, count(*)::int FROM pair_hours h JOIN leagues l ON l.id = h.league_id GROUP BY l.realm
       UNION ALL SELECT 'rejected_responses', realm, count(*)::int FROM rejected_responses GROUP BY realm
       UNION ALL SELECT 'ingestion_cursors', realm, count(*)::int FROM ingestion_cursors GROUP BY realm
       ORDER BY 1`,
    );
    assert.deepEqual(rows, [
      { source: 'ingestion_cursors', realm: 'pc', n: 1 },
      { source: 'pair_hours', realm: 'pc', n: 2 * FIXTURE_MARKETS },
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
    assert.equal(await count('pair_hours'), 2 * FIXTURE_MARKETS);
    assert.equal(await count('raw_digests'), 2);
  });

  it('keeps the stored response and rows when an hour comes back different', async () => {
    const exchange = new FakeExchange(1);
    await ingest(pool, exchange, options());
    await pool.query('UPDATE ingestion_cursors SET next_cursor = $1', [H0]);
    const extra = marketJson('Standard', 'Metadata/Items/Currency/ChangedA', 'Metadata/Items/Currency/ChangedB');
    exchange.overrides.set(H0, { url: 'fake', status: 200, body: hourBody(H0, extra) });

    const replay = await ingest(pool, exchange, options());
    assert.equal(replay.hoursStored, 1);
    assert.equal(replay.marketsInserted, 0);
    assert.equal(await count('pair_hours'), FIXTURE_MARKETS);
    const { rows } = await pool.query<{ market_count: number }>('SELECT market_count FROM raw_digests');
    assert.deepEqual(rows, [{ market_count: FIXTURE_MARKETS }]);
  });

  it('stores integers up to 2^53 - 1 exactly', async () => {
    const extra = marketJson('Precision', 'Metadata/Items/Currency/PrecisionA', 'Metadata/Items/Currency/PrecisionB', [
      '9007199254740991',
      '0',
    ]);
    const exchange = new FakeExchange(1);
    exchange.overrides.set(H0, { url: 'fake', status: 200, body: hourBody(H0, extra) });
    await ingest(pool, exchange, options({ maxHours: 1 }));

    const { rows } = await pool.query(
      `SELECT h.volume_traded_a, h.highest_ratio_b FROM pair_hours h JOIN leagues l ON l.id = h.league_id WHERE l.name = 'Precision'`,
    );
    assert.deepEqual(rows, [{ volume_traded_a: '9007199254740991', highest_ratio_b: '0' }]);
  });

  it('rejects fractional values without storing the hour', async () => {
    const extra = marketJson('Precision', 'Metadata/Items/Currency/PrecisionA', 'Metadata/Items/Currency/PrecisionB', ['1.50', '2']);
    const exchange = new FakeExchange(2);
    exchange.overrides.set(H0 + HOUR, { url: 'fake', status: 200, body: hourBody(H0 + HOUR, extra) });

    await assert.rejects(ingest(pool, exchange, options()), MalformedResponseError);
    assert.equal(await readCursor(pool), H0 + HOUR);
    assert.equal(await count('pair_hours'), FIXTURE_MARKETS);
    assert.equal(await count('rejected_responses'), 1);
  });

  it('rejects an hour that lists a stored pair in the reverse order', async () => {
    const a = 'Metadata/Items/Currency/CurrencyCorrupt';
    const b = 'Metadata/Items/Currency/CurrencyRerollRare';
    const exchange = new FakeExchange(3);
    exchange.overrides.set(H0 + HOUR, {
      url: 'fake',
      status: 200,
      body: JSON.stringify({ next_change_id: H0 + 2 * HOUR, markets: [JSON.parse(marketJson('Settlers', b, a))] }),
    });

    await assert.rejects(ingest(pool, exchange, options()), /reverse order/);
    assert.equal(await readCursor(pool), H0 + HOUR);
    assert.equal(await count('raw_digests'), 1);
    assert.equal(await count('pair_hours'), FIXTURE_MARKETS);
    assert.equal(await count('pairs'), FIXTURE.pairs);
    const { rows } = await pool.query('SELECT request_cursor, problems FROM rejected_responses');
    assert.equal(rows[0]?.request_cursor, String(H0 + HOUR));
    assert.match(JSON.stringify(rows[0]?.problems), /stored before in the reverse order/);
  });

  it('rolls back market rows, dictionaries and the digest when the cursor update fails', async () => {
    await pool.query('ALTER TABLE ingestion_cursors ADD CONSTRAINT test_reject_cursor CHECK (next_cursor < 0)');
    try {
      await assert.rejects(ingest(pool, new FakeExchange(2), options()), /test_reject_cursor/);
    } finally {
      await pool.query('ALTER TABLE ingestion_cursors DROP CONSTRAINT test_reject_cursor');
    }
    assert.equal(await count('pair_hours'), 0);
    assert.equal(await count('items'), 0);
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
    assert.equal(await count('pair_hours'), 0);
  });
});
