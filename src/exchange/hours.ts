export const HOUR_SECONDS = 3600;

/** Exchange cursors are unix timestamps (seconds) aligned to the start of an hour. */
export function isHourCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value % HOUR_SECONDS === 0;
}

export function hourIso(cursor: number): string {
  return new Date(cursor * 1000).toISOString();
}

export function currentHourCursor(now: Date): number {
  return Math.floor(now.getTime() / 1000 / HOUR_SECONDS) * HOUR_SECONDS;
}

export type StartPoint = { kind: 'earliest' } | { kind: 'hour'; cursor: number };

export const DEFAULT_BOOTSTRAP_HOURS_AGO = 24;

/** Where the first run starts when no cursor is stored: 24 completed hours ago. */
export function defaultStart(now: Date): StartPoint {
  return { kind: 'hour', cursor: currentHourCursor(now) - DEFAULT_BOOTSTRAP_HOURS_AGO * HOUR_SECONDS };
}

/**
 * Parses `--start`: `earliest`, a unix timestamp in seconds, or an ISO 8601 time with a zone
 * (e.g. `2026-09-22T00:00Z`). The time must fall exactly on an hour.
 */
export function parseStart(value: string): StartPoint {
  if (value === 'earliest') return { kind: 'earliest' };
  const seconds = /^\d+$/.test(value) ? Number(value) : Date.parse(value) / 1000;
  if (Number.isNaN(seconds) || !/^\d+$|(Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    throw new Error(`--start must be "earliest", unix seconds, or an ISO time with a zone; got "${value}"`);
  }
  if (!isHourCursor(seconds)) {
    throw new Error(`--start must be on an hour boundary (minutes and seconds zero); got "${value}"`);
  }
  return { kind: 'hour', cursor: seconds };
}
