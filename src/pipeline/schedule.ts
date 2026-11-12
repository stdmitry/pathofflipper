import { currentHourCursor, HOUR_SECONDS } from '../exchange/hours.ts';
import type { TickResult } from './runner.ts';

/** The exchange publishes an hour right after it ends (specs/exchange-api-observations.md); the first tick is at hh:01. */
export const TICK_OFFSET_MS = 60_000;
/** While the newest completed hour is not stored yet, retry this often... */
export const RETRY_MS = 5 * 60_000;
/** ...until this many minutes past the hour, then wait for the next hour. */
export const RETRY_UNTIL_MINUTE = 30;

/**
 * Milliseconds until the next tick after `tick` finished at `now`:
 * - 0 when fetch stopped at its hour limit, so a backlog drains without waiting;
 * - the next hh:01 when the newest completed hour is stored;
 * - otherwise 5 minutes, until hh:30, then the next hh:01.
 */
export function nextTickDelay(now: Date, tick: TickResult): number {
  const fetch = tick.jobs.find((j) => j.job === 'fetch');
  if (fetch?.details?.stop_reason === 'limit') return 0;
  const hourStart = currentHourCursor(now) * 1000;
  let nextHour = hourStart + TICK_OFFSET_MS;
  if (now.getTime() >= nextHour) nextHour += HOUR_SECONDS * 1000;
  const untilNextHour = nextHour - now.getTime();

  const lastCompleted = hourStart - HOUR_SECONDS * 1000;
  const newest = fetch?.outputWatermark ? Date.parse(fetch.outputWatermark) : null;
  if (newest !== null && newest >= lastCompleted) return untilNextHour;
  if (now.getTime() - hourStart >= RETRY_UNTIL_MINUTE * 60_000) return untilNextHour;
  return Math.min(RETRY_MS, untilNextHour);
}
