import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.ts';
import { checkSemantics } from '../src/semantics-check.ts';
import { resetSchema, skipWithoutDatabase as skip, TEST_DATABASE_URL } from './support.ts';

// volume a, b; lowest_stock a, b; highest_stock a, b; lowest_ratio a, b; highest_ratio a, b.
type Values = [number, number, number, number, number, number, number, number, number, number];
const VALID: Values = [13204338, 40466, 4518606, 4865, 5075807, 9024, 305, 1, 330, 1];
const LISTED: Values = [0, 0, 0, 399125, 0, 399125, 0, 0, 0, 0];

describe('checkSemantics (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;
  let hour = 0;

  async function insert(values: Values, league = 'Mirage'): Promise<void> {
    hour += 1;
    await pool.query(
      `INSERT INTO pair_hours (league_id, pair_id, source_hour, volume_traded_a, volume_traded_b, lowest_stock_a,
         lowest_stock_b, highest_stock_a, highest_stock_b, lowest_ratio_a, lowest_ratio_b, highest_ratio_a, highest_ratio_b)
       VALUES ((SELECT id FROM leagues WHERE name = $1), 1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [league, hour * 3600, ...values],
    );
  }

  async function violations(league?: string): Promise<Record<string, number>> {
    const report = await checkSemantics(pool, league);
    return Object.fromEntries(report.results.filter((r) => r.violations > 0).map((r) => [r.name, r.violations]));
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
    await pool.query('TRUNCATE pair_hours, pairs, items, leagues RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO leagues (realm, name) VALUES ('pc', 'Mirage'), ('pc', 'Standard')`);
    await pool.query(`INSERT INTO items (metadata_path) VALUES ('A'), ('B')`);
    await pool.query('INSERT INTO pairs (item_a_id, item_b_id) VALUES (1, 2)');
  });

  it('passes real traded and listed-only rows', async () => {
    await insert(VALID);
    await insert(LISTED);
    const report = await checkSemantics(pool);
    assert.equal(report.rows, 2);
    assert.deepEqual(await violations(), {});
  });

  it('reports each broken invariant', async () => {
    await insert([5, 0, 0, 0, 0, 0, 1, 1, 1, 1]); // one-sided volume, so its rate is also outside the extremes
    await insert([0, 0, 1, 1, 1, 1, 2, 1, 2, 1]); // ratio without a trade
    await insert([10, 5, 0, 0, 0, 0, 4, 2, 2, 1]); // unreduced ratio
    await insert([10, 5, 0, 0, 0, 0, 3, 1, 1, 1]); // lowest above highest, rate below lowest
    await insert([100, 1, 0, 0, 0, 0, 1, 1, 2, 1]); // rate above highest
    await insert([0, 0, 5, 0, 4, 0, 0, 0, 0, 0]); // stock inverted
    assert.deepEqual(await violations(), {
      volume_both_sides: 1,
      ratio_iff_traded: 1,
      ratio_reduced: 1,
      ratio_ordered: 1,
      volume_rate_within_extremes: 3,
      stock_ordered: 1,
    });
  });

  it('checks values beyond the bigint product range exactly', async () => {
    const big = 2 ** 53 - 1;
    await insert([big, big - 1, 0, 0, 0, 0, 1, 1, big, big - 1]);
    assert.deepEqual(await violations(), {});
  });

  it('limits the check to one league', async () => {
    await insert(VALID, 'Mirage');
    await insert([5, 0, 0, 0, 0, 0, 1, 1, 1, 1], 'Standard');
    assert.deepEqual(await violations('Mirage'), {});
    assert.deepEqual(await violations('Standard'), { volume_both_sides: 1, volume_rate_within_extremes: 1 });
  });
});
