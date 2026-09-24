import type pg from 'pg';
import { MalformedResponseError, NUMERIC_FIELDS, type MarketRecord } from '../exchange/parse.ts';
import type { ItemNames } from '../items.ts';

const VALUE_COLUMNS = NUMERIC_FIELDS.flatMap((field) => [`${field}_a`, `${field}_b`]);

/**
 * Stores one hour's markets in pair_hours, adding unknown leagues, items and pairs first. Runs inside the caller's
 * transaction. Rows already stored for the hour are kept. Returns the number of rows inserted.
 *
 * Throws MalformedResponseError when a market_pair was stored before in the reverse order.
 */
export async function storeMarkets(
  client: pg.PoolClient,
  realm: string,
  sourceHour: number,
  markets: readonly MarketRecord[],
  itemNames: ItemNames,
): Promise<number> {
  if (markets.length === 0) return 0;

  const leagueNames = [...new Set(markets.map((market) => market.league))];
  await client.query('INSERT INTO leagues (realm, name) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [
    realm,
    leagueNames,
  ]);
  const leagues = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM leagues WHERE realm = $1 AND name = ANY($2::text[])',
    [realm, leagueNames],
  );
  const leagueIds = new Map(leagues.rows.map((row) => [row.name, row.id]));

  // Names fill in when the vendored snapshot learns a path; an unknown path never erases a stored name.
  const paths = [...new Set(markets.flatMap((market) => market.pair))];
  await client.query(
    `INSERT INTO items (metadata_path, display_name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (metadata_path) DO UPDATE SET display_name = EXCLUDED.display_name
       WHERE EXCLUDED.display_name IS NOT NULL AND items.display_name IS DISTINCT FROM EXCLUDED.display_name`,
    [paths, paths.map((itemPath) => itemNames.get(itemPath) ?? null)],
  );
  const items = await client.query<{ id: number; metadata_path: string }>(
    'SELECT id, metadata_path FROM items WHERE metadata_path = ANY($1::text[])',
    [paths],
  );
  const itemIds = new Map(items.rows.map((row) => [row.metadata_path, row.id]));

  const pairKey = (a: number, b: number) => `${a}|${b}`;
  const pairItems = new Map<string, [number, number]>();
  for (const { pair } of markets) {
    const ids: [number, number] = [itemIds.get(pair[0])!, itemIds.get(pair[1])!];
    pairItems.set(pairKey(...ids), ids);
  }
  const aIds = [...pairItems.values()].map(([a]) => a);
  const bIds = [...pairItems.values()].map(([, b]) => b);
  // A reversed pair conflicts on pairs_unordered_key, is skipped here and then missing from the lookup below.
  await client.query('INSERT INTO pairs (item_a_id, item_b_id) SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING', [
    aIds,
    bIds,
  ]);
  const pairs = await client.query<{ id: number; item_a_id: number; item_b_id: number }>(
    `SELECT p.id, p.item_a_id, p.item_b_id
     FROM pairs p JOIN unnest($1::int[], $2::int[]) AS u (a, b) ON p.item_a_id = u.a AND p.item_b_id = u.b`,
    [aIds, bIds],
  );
  const pairIds = new Map(pairs.rows.map((row) => [pairKey(row.item_a_id, row.item_b_id), row.id]));

  const reversed = markets
    .filter(({ pair }) => !pairIds.has(pairKey(itemIds.get(pair[0])!, itemIds.get(pair[1])!)))
    .map(({ pair }) => `market_pair ${pair[0]}|${pair[1]} was stored before in the reverse order`);
  if (reversed.length > 0) throw new MalformedResponseError('Invalid market records', [...new Set(reversed)]);

  const columns: unknown[][] = [[], [], ...VALUE_COLUMNS.map(() => [])];
  for (const market of markets) {
    columns[0]!.push(leagueIds.get(market.league));
    columns[1]!.push(pairIds.get(pairKey(itemIds.get(market.pair[0])!, itemIds.get(market.pair[1])!)));
    NUMERIC_FIELDS.forEach((field, index) => {
      columns[2 + 2 * index]!.push(market.values[field][0]);
      columns[3 + 2 * index]!.push(market.values[field][1]);
    });
  }
  const valueParams = VALUE_COLUMNS.map((_, index) => `$${index + 4}::bigint[]`).join(', ');
  const result = await client.query(
    `INSERT INTO pair_hours (league_id, pair_id, source_hour, ${VALUE_COLUMNS.join(', ')})
     SELECT u.league_id, u.pair_id, to_timestamp($1), ${VALUE_COLUMNS.map((column) => `u.${column}`).join(', ')}
     FROM unnest($2::int[], $3::int[], ${valueParams}) AS u (league_id, pair_id, ${VALUE_COLUMNS.join(', ')})
     ON CONFLICT (league_id, pair_id, source_hour) DO NOTHING`,
    [sourceHour, ...columns],
  );
  return result.rowCount ?? 0;
}
