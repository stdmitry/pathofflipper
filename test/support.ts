import { readFileSync } from 'node:fs';
import type pg from 'pg';
import type { ExchangeResponse, ExchangeSource } from '../src/exchange/client.ts';
import { ingest } from '../src/ingest.ts';
import { parsePending } from '../src/parse-hours.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skipWithoutDatabase = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set (see README: Tests)';

export const H0 = 1722027600;
export const HOUR = 3600;
/** Markets, leagues, items and pairs in the fixture hour. */
export const FIXTURE = { markets: 232, leagues: 19, items: 55, pairs: 176 } as const;
export const fixtureBody = readFileSync(new URL('./fixtures/pc-1722027600.json', import.meta.url), 'utf8');

/** The fixture re-labelled as the response for `cursor`, optionally with raw market JSON prepended. */
export function hourBody(cursor: number, extraMarketJson?: string): string {
  let body = fixtureBody.replace(/"next_change_id":\d+/, `"next_change_id":${cursor + HOUR}`);
  if (extraMarketJson) body = body.replace('"markets":[', `"markets":[${extraMarketJson},`);
  return body;
}

/** One market as raw JSON, with every numeric field set to `values` for (a, b). */
export function marketJson(league: string, a: string, b: string, values: [string, string] = ['1', '2']): string {
  const map = `{"${a}":${values[0]},"${b}":${values[1]}}`;
  return (
    `{"league":"${league}","market_id":"${a}|${b}","market_pair":["${a}","${b}"],"volume_traded":${map},` +
    `"lowest_stock":${map},"highest_stock":${map},"lowest_ratio":${map},"highest_ratio":${map}}`
  );
}

/** Drops everything in the test database, so each file migrates from scratch. */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
}

export async function count(pool: pg.Pool, table: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
}

/** Serves `hours` published hours starting at H0; later cursors answer like the unpublished current hour. */
export class FakeExchange implements ExchangeSource {
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

/** Three consecutive real Mirage hours from 2026-04-15 10:00 UTC, trimmed to 7 markets each (values unmodified). */
export const mirageFixture = JSON.parse(
  readFileSync(new URL('./fixtures/pc-mirage-1776247200-3h.json', import.meta.url), 'utf8'),
) as { hours: { source_hour: number; market_count: number; body: { next_change_id: number; markets: unknown[] } }[] };

export const CHAOS_PATH = 'Metadata/Items/Currency/CurrencyRerollRare';

/** Fetches and parses the Mirage fixture hours as H0..H0+2h, then an empty (exchange-down) response at H0+3h. */
export async function loadMirageHours(pool: pg.Pool): Promise<void> {
  const exchange = new FakeExchange(4);
  mirageFixture.hours.forEach(({ body }, i) => {
    const cursor = H0 + i * HOUR;
    exchange.overrides.set(cursor, { url: 'fake', status: 200, body: JSON.stringify({ ...body, next_change_id: cursor + HOUR }) });
  });
  const empty = H0 + 3 * HOUR;
  exchange.overrides.set(empty, { url: 'fake', status: 200, body: JSON.stringify({ next_change_id: empty + HOUR, markets: [] }) });
  await ingest(pool, exchange, { maxHours: 5, start: { kind: 'hour', cursor: H0 } });
  await parsePending(pool, { itemNames: new Map([[CHAOS_PATH, 'Chaos Orb']]) });
}
