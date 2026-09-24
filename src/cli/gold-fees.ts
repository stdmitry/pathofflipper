import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { DAT_EXPORT_URL, downloadGoldFees, GOLD_FEES_FILE, loadGoldFees } from '../gold.ts';
import { createLogger, errorMessage } from '../log.ts';

const USAGE = `Apply the vendored currency exchange gold fees (data/gold-fees.json) to the items table.

Usage: npm run gold-fees -- [--download]

Options:
  --download   First replace data/gold-fees.json with the CurrencyExchange table exported at ${DAT_EXPORT_URL}.
               Review and commit the diff; do this once per league or patch.
  -h, --help   Show this help

Run npm run metrics afterwards so gold figures use the new fees.`;

const logger = createLogger();

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { download: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const databaseUrl = requireEnv('DATABASE_URL');

  if (values.download) {
    const snapshot = await downloadGoldFees();
    await writeFile(GOLD_FEES_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
    logger.info('wrote gold fee snapshot', {
      file: GOLD_FEES_FILE,
      game_version: snapshot.game_version,
      items: Object.keys(snapshot.fees).length,
    });
  }

  const fees = await loadGoldFees();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    // Items missing from the snapshot lose any old fee: an unknown fee is shown as unknown, never as a stale number.
    const result = await pool.query(
      `UPDATE items SET gold_fee = u.fee
       FROM (SELECT i.id, f.fee FROM items i LEFT JOIN unnest($1::text[], $2::int[]) AS f (path, fee)
             ON f.path = i.metadata_path) AS u
       WHERE items.id = u.id AND items.gold_fee IS DISTINCT FROM u.fee`,
      [[...fees.keys()], [...fees.values()]],
    );
    const { rows } = await pool.query<{ missing: number }>('SELECT count(*)::int AS missing FROM items WHERE gold_fee IS NULL');
    logger.info('applied gold fees', { updated: result.rowCount ?? 0, items_without_fee: rows[0]?.missing });
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'gold-fees failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
