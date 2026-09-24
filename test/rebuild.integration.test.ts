import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.ts';
import { sha256 } from '../src/exchange/parse.ts';
import { parsePending } from '../src/parse-hours.ts';
import { rebuild } from '../src/rebuild.ts';
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

const itemNames = new Map([['Metadata/Items/Currency/CurrencyRerollRare', 'Chaos Orb']]);

describe('rebuild and the market_hours drop (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  const count = (table: string) => countRows(pool, table);

  /** Stores an hour the way the collector did before pair_hours existed: digest plus jsonb market_hours rows. */
  async function storeLegacyHour(cursor: number, body = hourBody(cursor)): Promise<void> {
    const marketCount = (JSON.parse(body) as { markets: unknown[] }).markets.length;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO raw_digests (realm, request_cursor, next_cursor, source_hour, http_status, market_count, checksum,
                                parser_version, payload, first_fetched_at, last_fetched_at)
       VALUES ('pc', $1::bigint, $1::bigint + 3600, to_timestamp($1::bigint), 200, $2, $3, 1, $4::jsonb, now(), now()) RETURNING id`,
      [cursor, marketCount, sha256(body), body],
    );
    await pool.query(
      `INSERT INTO market_hours (realm, league, source_hour, market_id, item_a_id, item_b_id, volume_traded,
                                 lowest_stock, highest_stock, lowest_ratio, highest_ratio, raw_digest_id, fetched_at)
       SELECT d.realm, m->>'league', d.source_hour, m->>'market_id', m->'market_pair'->>0, m->'market_pair'->>1,
              m->'volume_traded', m->'lowest_stock', m->'highest_stock', m->'lowest_ratio', m->'highest_ratio', d.id, now()
       FROM raw_digests d, jsonb_array_elements(d.payload->'markets') AS m
       WHERE d.id = $1`,
      [rows[0]!.id],
    );
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    // Migrate to the state right before 0003, where market_hours and pair_hours coexist.
    const dir = await mkdtemp(path.join(tmpdir(), 'pathofflipper-migrations-'));
    try {
      for (const file of ['0001_initial_ingestion.sql', '0002_compact_market_storage.sql']) {
        await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
      await runMigrations(pool, dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE market_hours, pair_hours, pairs, items, leagues, raw_digests, ingestion_cursors, rejected_responses RESTART IDENTITY CASCADE',
    );
  });

  it('rebuilds every stored hour, matches market_hours exactly and resumes without duplicates', async () => {
    await storeLegacyHour(H0);
    await storeLegacyHour(H0 + HOUR);

    const summary = await rebuild(pool, { itemNames });
    assert.deepEqual(summary, {
      stopped: false,
      hoursTotal: 2,
      hoursAlreadyComplete: 0,
      hoursRebuilt: 2,
      rowsInserted: 2 * FIXTURE.markets,
      invalidHours: [],
      countMismatches: [],
      valueMismatches: 0,
    });
    assert.equal(await count('pairs'), FIXTURE.pairs);
    const names = await pool.query(`SELECT display_name FROM items WHERE display_name IS NOT NULL`);
    assert.deepEqual(names.rows, [{ display_name: 'Chaos Orb' }]);
    const versions = await pool.query(`SELECT DISTINCT parser_version FROM raw_digests`);
    assert.deepEqual(versions.rows, [{ parser_version: 2 }]);

    const again = await rebuild(pool, { itemNames });
    assert.equal(again.hoursAlreadyComplete, 2);
    assert.equal(again.rowsInserted, 0);
    assert.equal(again.valueMismatches, 0);
    assert.equal(await count('pair_hours'), 2 * FIXTURE.markets);
  });

  it('completes a partially rebuilt hour', async () => {
    await storeLegacyHour(H0);
    await rebuild(pool, { itemNames });
    await pool.query(`DELETE FROM pair_hours WHERE pair_id IN (SELECT pair_id FROM pair_hours LIMIT 10)`);

    const summary = await rebuild(pool, { itemNames });
    assert.equal(summary.hoursRebuilt, 1);
    assert.ok(summary.rowsInserted >= 10);
    assert.deepEqual(summary.countMismatches, []);
    assert.equal(await count('pair_hours'), FIXTURE.markets);
  });

  it('reports values that differ from market_hours', async () => {
    await storeLegacyHour(H0);
    await pool.query(
      `UPDATE market_hours SET volume_traded = jsonb_set(volume_traded, ARRAY[item_a_id], '999999')
       WHERE ctid = (SELECT ctid FROM market_hours LIMIT 1)`,
    );
    const summary = await rebuild(pool, { itemNames });
    assert.equal(summary.valueMismatches, 1);
    assert.deepEqual(summary.countMismatches, []);
  });

  it('reports digests that fail the current parser and rebuilds the others', async () => {
    const fraction = marketJson('Standard', 'Metadata/Items/Currency/FractionA', 'Metadata/Items/Currency/FractionB', ['0.5', '1']);
    await storeLegacyHour(H0);
    await storeLegacyHour(H0 + HOUR, hourBody(H0 + HOUR, fraction));

    const summary = await rebuild(pool, { itemNames });
    assert.equal(summary.hoursRebuilt, 1);
    assert.equal(summary.invalidHours.length, 1);
    assert.equal(summary.invalidHours[0]?.sourceHour, new Date((H0 + HOUR) * 1000).toISOString());
    assert.match(summary.invalidHours[0]!.problem, /must be an integer/);
    // market_hours still has the invalid hour's rows, which pair_hours lacks.
    assert.equal(summary.countMismatches.length, 1);
    assert.equal(await count('pair_hours'), FIXTURE.markets);
  });

  it('refuses to run while a fetch holds the ingest lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7319001, hashtext($1))', ['pc']);
      await assert.rejects(rebuild(pool, { itemNames }), /already running/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });

  // Runs last: a successful 0003 drops market_hours.
  it('drops market_hours only after every stored hour is rebuilt', async () => {
    await storeLegacyHour(H0);
    await storeLegacyHour(H0 + HOUR);
    await assert.rejects(runMigrations(pool), /2 stored hours are not fully rebuilt/);
    assert.equal(await count('market_hours'), 2 * FIXTURE.markets);

    await rebuild(pool, { itemNames });
    await pool.query(`DELETE FROM pair_hours WHERE pair_id = (SELECT min(pair_id) FROM pair_hours)`);
    await assert.rejects(runMigrations(pool), /not fully rebuilt/);

    await rebuild(pool, { itemNames });
    assert.deepEqual(await runMigrations(pool), [
      '0003_drop_market_hours.sql',
      '0004_separate_parsing.sql',
      '0005_market_metrics.sql',
      '0006_league_hours.sql',
      '0007_private_leagues.sql',
      '0008_rank_score.sql',
      '0009_gold_fees.sql',
    ]);
    // 0006 fills league_hours from the rebuilt pair_hours.
    assert.equal(await count('league_hours'), 2 * FIXTURE.leagues);
    const { rows } = await pool.query(`SELECT to_regclass('market_hours') AS t`);
    assert.equal(rows[0]?.t, null);
    // Rebuilt digests count as parsed, so the parse stage has nothing left to do.
    assert.equal((await parsePending(pool, { itemNames })).hoursPending, 0);

    const afterDrop = await rebuild(pool, { itemNames });
    assert.equal(afterDrop.valueMismatches, null);
    assert.equal(afterDrop.hoursAlreadyComplete, 2);
  });
});
