import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.ts';
import { ingest } from '../src/ingest.ts';
import { computeMetrics } from '../src/metrics-run.ts';
import { parsePending } from '../src/parse-hours.ts';
import { runegraftPrices } from '../src/runegraft-prices.ts';
import {
  CHAOS_PATH,
  FakeExchange,
  H0,
  HOUR,
  marketJson,
  resetSchema,
  skipWithoutDatabase as skip,
  TEST_DATABASE_URL,
} from './support.ts';

const FORTRESS = 'Metadata/Items/Currency/RunegraftAttributeGlobalDefences';
const STABILITY = 'Metadata/Items/Currency/RunegraftUnexciting';
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';

describe('runegraftPrices (PostgreSQL)', { skip }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await resetSchema(pool);
    await runMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  it('reads every Runegraft Chaos market of the league from the snapshot, in either pair order', async () => {
    assert.deepEqual(await runegraftPrices(pool, 'Mirage', 24), { asOfHour: null, prices: [] });

    const markets = [
      // 45 Chaos for 3 Stability: 15 each, Chaos first.
      marketJson('Mirage', CHAOS_PATH, STABILITY, ['45', '3']),
      // 2 Fortress for 90 Chaos: 45 each, Runegraft first.
      marketJson('Mirage', FORTRESS, CHAOS_PATH, ['2', '90']),
      marketJson('Mirage', CHAOS_PATH, DIVINE, ['300', '1']),
      marketJson('Limey Whelps (PL86569)', CHAOS_PATH, FORTRESS, ['10', '1']),
    ];
    const exchange = new FakeExchange(1);
    exchange.overrides.set(H0, { url: 'fake', status: 200, body: `{"next_change_id":${H0 + HOUR},"markets":[${markets.join(',')}]}` });
    await ingest(pool, exchange, { maxHours: 1, start: { kind: 'hour', cursor: H0 } });
    await parsePending(pool, { itemNames: new Map([[FORTRESS, 'Runegraft of the Fortress']]) });
    await computeMetrics(pool);

    const { asOfHour, prices } = await runegraftPrices(pool, 'Mirage', 24);
    assert.equal(asOfHour, H0);
    assert.deepEqual(prices, [
      { name: 'Runegraft of the Fortress', path: FORTRESS, buyPriceChaos: 45, sellPriceChaos: 45, availableQuantity: null },
      { name: 'RunegraftUnexciting', path: STABILITY, buyPriceChaos: 15, sellPriceChaos: 15, availableQuantity: null },
    ]);
    assert.deepEqual((await runegraftPrices(pool, 'Limey Whelps (PL86569)', 24)).prices, [], 'private leagues are not served');
  });
});
