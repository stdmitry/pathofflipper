import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { ITEM_NAMES_FILE, loadItemNames, REPOE_BASE_ITEMS_URL, snapshotFromBaseItems } from '../items.ts';
import { createLogger, errorMessage } from '../log.ts';

const USAGE = `Apply the vendored item display names (data/item-names.json) to the items table.

Usage: npm run item-names -- [--download]

Options:
  --download   First replace data/item-names.json with a fresh trim of ${REPOE_BASE_ITEMS_URL}.
               Review and commit the diff; do this once per league.
  -h, --help   Show this help

Paths missing from the snapshot keep their current name (NULL if they never had one).`;

const logger = createLogger();

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { download: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const databaseUrl = requireEnv('DATABASE_URL');

  if (values.download) {
    const response = await fetch(REPOE_BASE_ITEMS_URL);
    if (!response.ok) throw new Error(`${REPOE_BASE_ITEMS_URL} returned HTTP ${response.status}`);
    const snapshot = snapshotFromBaseItems(await response.json(), new Date());
    await writeFile(ITEM_NAMES_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
    logger.info('wrote item name snapshot', { file: ITEM_NAMES_FILE, names: Object.keys(snapshot.names).length });
  }

  const names = await loadItemNames();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `UPDATE items SET display_name = u.name
       FROM unnest($1::text[], $2::text[]) AS u (path, name)
       WHERE items.metadata_path = u.path AND items.display_name IS DISTINCT FROM u.name`,
      [[...names.keys()], [...names.values()]],
    );
    const { rows } = await pool.query<{ unnamed: number }>('SELECT count(*)::int AS unnamed FROM items WHERE display_name IS NULL');
    logger.info('applied item names', { updated: result.rowCount ?? 0, unnamed_items: rows[0]?.unnamed });
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'item-names failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
