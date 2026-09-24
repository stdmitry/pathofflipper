import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.ts';
import { PARSER_VERSION } from '../src/exchange/parse.ts';
import { ingest } from '../src/ingest.ts';
import { parsePending, type ParseOptions } from '../src/parse-hours.ts';
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
const PRECISION_A = 'Metadata/Items/Currency/PrecisionA';
const PRECISION_B = 'Metadata/Items/Currency/PrecisionB';

describe('parsePending (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  const count = (table: string) => countRows(pool, table);
  const parse = (overrides: Partial<ParseOptions> = {}) => parsePending(pool, { itemNames: new Map(), ...overrides });

  /** Fetches `hours` raw hours from H0, with `bodies` replacing the response for some cursors. */
  async function fetchHours(hours: number, bodies: Record<number, string> = {}): Promise<void> {
    const exchange = new FakeExchange(hours);
    for (const [cursor, body] of Object.entries(bodies)) {
      exchange.overrides.set(Number(cursor), { url: 'fake', status: 200, body });
    }
    await ingest(pool, exchange, { maxHours: hours + 1, start: { kind: 'hour', cursor: H0 } });
  }

  async function digestStates() {
    const { rows } = await pool.query<{ source_hour: string; parser_version: number | null; parse_error: string | null }>(
      `SELECT extract(epoch FROM source_hour)::bigint AS source_hour, parser_version, parse_error
       FROM raw_digests ORDER BY source_hour`,
    );
    return rows;
  }

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

  it('parses pending hours into dictionaries and pair_hours and marks them parsed', async () => {
    await fetchHours(2);
    const summary = await parse();

    assert.deepEqual(summary, {
      stopped: false,
      hoursPending: 2,
      hoursParsed: 2,
      rowsInserted: 2 * FIXTURE_MARKETS,
      failedHours: [],
    });
    assert.equal(await count('pair_hours'), 2 * FIXTURE_MARKETS);
    assert.equal(await count('leagues'), FIXTURE.leagues);
    assert.equal(await count('items'), FIXTURE.items);
    assert.equal(await count('pairs'), FIXTURE.pairs);
    assert.deepEqual(await digestStates(), [
      { source_hour: String(H0), parser_version: PARSER_VERSION, parse_error: null },
      { source_hour: String(H0 + HOUR), parser_version: PARSER_VERSION, parse_error: null },
    ]);

    // Values keep the upstream item order: _a is keyed by market_pair[0] (CurrencyCorrupt), _b by market_pair[1].
    const sample = await pool.query(
      `SELECT h.volume_traded_a, h.volume_traded_b, h.highest_stock_a, h.highest_stock_b, h.lowest_ratio_a, h.lowest_ratio_b
       FROM pair_hours h
       JOIN leagues l ON l.id = h.league_id
       JOIN pairs p ON p.id = h.pair_id
       JOIN items a ON a.id = p.item_a_id
       JOIN items b ON b.id = p.item_b_id
       WHERE l.realm = 'pc' AND l.name = 'Settlers' AND h.source_hour = to_timestamp($1)
         AND a.metadata_path = 'Metadata/Items/Currency/CurrencyCorrupt'
         AND b.metadata_path = 'Metadata/Items/Currency/CurrencyRerollRare'`,
      [H0],
    );
    assert.deepEqual(sample.rows, [
      { volume_traded_a: '2', volume_traded_b: '1', highest_stock_a: '15', highest_stock_b: '0', lowest_ratio_a: '2', lowest_ratio_b: '1' },
    ]);
  });

  it('skips parsed hours and does not duplicate rows when an hour is parsed again', async () => {
    await fetchHours(2);
    await parse();
    assert.equal((await parse()).hoursPending, 0);

    await pool.query('UPDATE raw_digests SET parser_version = NULL');
    const again = await parse();
    assert.equal(again.hoursParsed, 2);
    assert.equal(again.rowsInserted, 0);
    assert.equal(await count('pair_hours'), 2 * FIXTURE_MARKETS);
  });

  it('names items from the item name map and leaves unknown paths unnamed', async () => {
    const itemNames = new Map([
      ['Metadata/Items/Currency/CurrencyRerollRare', 'Chaos Orb'],
      ['Metadata/Items/Currency/CurrencyCorrupt', 'Vaal Orb'],
    ]);
    await fetchHours(1);
    await parse({ itemNames });
    const { rows } = await pool.query(
      `SELECT metadata_path, display_name FROM items WHERE display_name IS NOT NULL ORDER BY metadata_path`,
    );
    assert.deepEqual(rows, [
      { metadata_path: 'Metadata/Items/Currency/CurrencyCorrupt', display_name: 'Vaal Orb' },
      { metadata_path: 'Metadata/Items/Currency/CurrencyRerollRare', display_name: 'Chaos Orb' },
    ]);

    // A later snapshot can add a name; a path missing from it keeps its stored name.
    await pool.query('UPDATE raw_digests SET parser_version = NULL');
    await parse({ itemNames: new Map([['Metadata/Items/Currency/CurrencyCorrupt', 'Vaal']]) });
    const renamed = await pool.query(`SELECT count(*)::int AS n FROM items WHERE display_name IN ('Vaal', 'Chaos Orb')`);
    assert.equal(renamed.rows[0]?.n, 2);
  });

  it('stores integers up to 2^53 - 1 exactly', async () => {
    const extra = marketJson('Precision', PRECISION_A, PRECISION_B, ['9007199254740991', '0']);
    await fetchHours(1, { [H0]: hourBody(H0, extra) });
    await parse();

    const { rows } = await pool.query(
      `SELECT h.volume_traded_a, h.highest_ratio_b FROM pair_hours h JOIN leagues l ON l.id = h.league_id WHERE l.name = 'Precision'`,
    );
    assert.deepEqual(rows, [{ volume_traded_a: '9007199254740991', highest_ratio_b: '0' }]);
  });

  it('leaves an invalid hour pending with its problems, parses later hours and retries it next run', async () => {
    const extra = marketJson('Precision', PRECISION_A, PRECISION_B, ['1.50', '2']);
    await fetchHours(3, { [H0 + HOUR]: hourBody(H0 + HOUR, extra) });

    const summary = await parse();
    assert.equal(summary.hoursParsed, 2);
    assert.equal(summary.failedHours.length, 1);
    assert.match(summary.failedHours[0]!.problem, /must be an integer/);
    assert.equal(await count('pair_hours'), 2 * FIXTURE_MARKETS);
    const failed = (await digestStates())[1]!;
    assert.equal(failed.parser_version, null);
    assert.match(failed.parse_error!, /volume_traded\[Metadata\/Items\/Currency\/PrecisionA\] must be an integer.*1\.5/);

    // Nothing changed: the next run tries again and fails the same way.
    assert.equal((await parse()).failedHours.length, 1);

    // Once the digest parses (here, with the offending market removed), the hour is stored and the error cleared.
    await pool.query(
      `UPDATE raw_digests SET payload = jsonb_set(payload, '{markets}', (payload->'markets') - 0), market_count = market_count - 1
       WHERE source_hour = to_timestamp($1)`,
      [H0 + HOUR],
    );
    const retried = await parse();
    assert.equal(retried.hoursParsed, 1);
    assert.deepEqual(retried.failedHours, []);
    assert.equal(await count('pair_hours'), 3 * FIXTURE_MARKETS);
    assert.deepEqual((await digestStates())[1], { source_hour: String(H0 + HOUR), parser_version: PARSER_VERSION, parse_error: null });
  });

  it('fails an hour that lists a stored pair in the reverse order without storing any of it', async () => {
    const a = 'Metadata/Items/Currency/CurrencyCorrupt';
    const b = 'Metadata/Items/Currency/CurrencyRerollRare';
    const reversed = JSON.stringify({ next_change_id: H0 + 2 * HOUR, markets: [JSON.parse(marketJson('Settlers', b, a))] });
    await fetchHours(2, { [H0 + HOUR]: reversed });

    const summary = await parse();
    assert.equal(summary.hoursParsed, 1);
    assert.match(summary.failedHours[0]!.problem, /reverse order/);
    assert.equal(await count('pair_hours'), FIXTURE_MARKETS);
    assert.equal(await count('pairs'), FIXTURE.pairs);
    assert.match((await digestStates())[1]!.parse_error!, /stored before in the reverse order/);
  });

  it('refuses to run while another parse holds the parse lock, but not while a fetch runs', async () => {
    await fetchHours(1);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7319002, hashtext($1))', ['pc']);
      await assert.rejects(parse(), /already running/);
      await holder.query('SELECT pg_advisory_unlock_all()');

      await holder.query('SELECT pg_advisory_lock(7319001, hashtext($1))', ['pc']);
      assert.equal((await parse()).hoursParsed, 1);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });
});
