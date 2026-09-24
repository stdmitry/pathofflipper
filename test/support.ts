import { readFileSync } from 'node:fs';
import type pg from 'pg';

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
