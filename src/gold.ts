import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Gold fees of the currency exchange. Placing an order costs gold, and the game data gives each exchange item a
 * GoldPurchaseFee (table CurrencyExchange). The cost depends only on the item the order *wants*, not the item it
 * offers (checked in game on 2026-09-24), and is taken to be that fee times the quantity wanted.
 */

/** Vendored fees keyed by Metadata path; regenerate with `npm run gold-fees -- --download`. */
export const GOLD_FEES_FILE = path.join(import.meta.dirname, '..', 'data', 'gold-fees.json');

/** CSV exports of the game's data tables, maintained by the RePoE fork. */
export const DAT_EXPORT_URL = 'https://raw.githubusercontent.com/repoe-fork/dat-export/develop';

export type GoldFees = ReadonlyMap<string, number>;

export interface GoldFeesSnapshot {
  source: string;
  /** PoE 1 client version the tables were exported from. */
  game_version: string;
  retrieved_at: string;
  fees: Record<string, number>;
}

export async function loadGoldFees(file = GOLD_FEES_FILE): Promise<GoldFees> {
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as GoldFeesSnapshot;
  return new Map(Object.entries(snapshot.fees));
}

/** Parses RFC 4180 CSV (quoted fields may hold commas, quotes and newlines) into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV rows as objects keyed by the header row. */
function records(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
}

/**
 * Builds the fee snapshot from the exported CurrencyExchange and BaseItemTypes tables. CurrencyExchange.Item is a row
 * number of BaseItemTypes, whose Id is the Metadata path the exchange API uses. Paths are sorted for stable diffs.
 */
export function snapshotFromExport(
  currencyExchangeCsv: string,
  baseItemTypesCsv: string,
  gameVersion: string,
  retrievedAt: Date,
): GoldFeesSnapshot {
  const paths = new Map(records(baseItemTypesCsv).map((r) => [r.rownum, r.Id]));
  const fees: [string, number][] = [];
  for (const row of records(currencyExchangeCsv)) {
    const itemPath = paths.get(row.Item ?? '');
    const fee = Number(row.GoldPurchaseFee);
    if (!itemPath) throw new Error(`CurrencyExchange row ${row.rownum} refers to unknown BaseItemTypes row ${row.Item}`);
    if (!Number.isSafeInteger(fee) || fee < 0) throw new Error(`CurrencyExchange row ${row.rownum} has fee ${row.GoldPurchaseFee}`);
    fees.push([itemPath, fee]);
  }
  fees.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    source: `${DAT_EXPORT_URL}/current/poe/heuristics/csv/CurrencyExchange.csv`,
    game_version: gameVersion,
    retrieved_at: retrievedAt.toISOString(),
    fees: Object.fromEntries(fees),
  };
}

/** Downloads the current export and builds the snapshot. */
export async function downloadGoldFees(fetchText = defaultFetchText): Promise<GoldFeesSnapshot> {
  const [exchange, baseItems, version] = await Promise.all([
    fetchText(`${DAT_EXPORT_URL}/current/poe/heuristics/csv/CurrencyExchange.csv`),
    fetchText(`${DAT_EXPORT_URL}/current/poe/heuristics/csv/BaseItemTypes.csv`),
    fetchText(`${DAT_EXPORT_URL}/version.txt`),
  ]);
  return snapshotFromExport(exchange, baseItems, version.trim(), new Date());
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}
