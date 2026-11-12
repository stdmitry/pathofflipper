import type pg from 'pg';
import { snapshot } from '../api/queries.ts';
import { REALM } from '../config.ts';
import type { ExchangeSource } from '../exchange/client.ts';
import { defaultStart, hourIso, type StartPoint } from '../exchange/hours.ts';
import { ingest } from '../ingest.ts';
import { loadItemNames, type ItemNames } from '../items.ts';
import { CALC_VERSION } from '../market/metrics.ts';
import { QUOTE_ITEMS, QUOTE_NAMES } from '../market/quotes.ts';
import { RUNEGRAFT_WEIGHTS_FILE } from '../market/runegraft.ts';
import { computeMetrics } from '../metrics-run.ts';
import { parsePending } from '../parse-hours.ts';
import { computeRunegraftRuns, readWeightsFile } from '../runegraft-run.ts';
import { checkSemantics } from '../semantics-check.ts';
import type { Job, JobState } from './job.ts';

const MINUTE = 60_000;

export interface JobsConfig {
  exchange: ExchangeSource;
  /** Hours fetched per tick at most; a longer backlog continues in the next tick. */
  maxHours: number;
  /** Where the first fetch starts when no cursor is stored; default 24 completed hours before the tick. */
  start?: StartPoint;
  /** Pause between exchange requests. */
  pauseMs: number;
  weightsFile?: string;
  /** Item display names for parse; read from data/item-names.json per run when not given. */
  itemNames?: ItemNames;
}

export const JOB_NAMES = ['fetch', 'parse', 'metrics', 'runegraft', 'check-semantics'] as const;

/** fetch → parse → metrics → runegraft, and a daily check-semantics after parse. */
export function createJobs(pool: pg.Pool, config: JobsConfig): Job[] {
  const weightsFile = config.weightsFile ?? RUNEGRAFT_WEIGHTS_FILE;
  return [
    {
      name: 'fetch',
      dependsOn: [],
      timeoutMs: 30 * MINUTE,
      async run(ctx) {
        const summary = await ingest(pool, config.exchange, {
          maxHours: config.maxHours,
          start: config.start ?? defaultStart(ctx.now),
          pauseMs: config.pauseMs,
          shouldStop: ctx.shouldStop,
          logger: ctx.logger,
        });
        const newest = await newestHour(pool, false);
        return {
          outputWatermark: newest,
          details: {
            stop_reason: summary.stopReason,
            hours_stored: summary.hoursStored,
            next_hour: summary.nextCursor === null ? null : hourIso(summary.nextCursor),
          },
          idle: summary.hoursStored === 0 && summary.stopReason === 'caught-up',
          interrupted: summary.stopReason === 'interrupted',
        };
      },
    },
    {
      name: 'parse',
      dependsOn: ['fetch'],
      timeoutMs: 30 * MINUTE,
      inputWatermark: () => newestHour(pool, false),
      async run(ctx) {
        const summary = await parsePending(pool, {
          itemNames: config.itemNames ?? (await loadItemNames()),
          shouldStop: ctx.shouldStop,
          logger: ctx.logger,
        });
        const failed = summary.failedHours.length;
        return {
          outputWatermark: await newestHour(pool, true),
          details: { parsed: summary.hoursParsed, rows_inserted: summary.rowsInserted, failed },
          idle: summary.hoursParsed === 0 && failed === 0 && !summary.stopped,
          interrupted: summary.stopped,
          ...(failed > 0 ? { problem: `${failed} hours failed validation; see raw_digests.parse_error` } : {}),
        };
      },
    },
    {
      name: 'metrics',
      dependsOn: ['parse'],
      timeoutMs: 10 * MINUTE,
      // A new calculation version recomputes the same hour.
      inputWatermark: async () => {
        const parsed = await newestHour(pool, true);
        return parsed === null ? null : `${parsed} v${CALC_VERSION}`;
      },
      async run(ctx) {
        const details: Record<string, unknown> = {};
        for (const quote of QUOTE_NAMES) {
          const summary = await computeMetrics(pool, { quote, logger: ctx.logger });
          details[`${quote}_markets`] = summary.markets;
          details[`${quote}_eligible`] = summary.eligible;
          details.as_of = summary.asOfHour === null ? null : hourIso(summary.asOfHour);
        }
        const snap = await snapshot(pool, QUOTE_ITEMS.chaos.path);
        return { outputWatermark: snap ? hourIso(snap.asOfHour) : null, details };
      },
    },
    {
      name: 'runegraft',
      dependsOn: ['metrics'],
      timeoutMs: 2 * MINUTE,
      // The snapshot's run id changes on every metrics run, so a recompute of the same hour (e.g. new gold fees) and an
      // edited weights file both rerun it.
      inputWatermark: async () => {
        const snap = await snapshot(pool, QUOTE_ITEMS.chaos.path);
        if (!snap) return null;
        const { sha256 } = await readWeightsFile(weightsFile);
        return `${hourIso(snap.asOfHour)} run ${snap.runId} weights ${sha256.slice(0, 12)}`;
      },
      async run(ctx) {
        const summary = await computeRunegraftRuns(pool, { weights: await readWeightsFile(weightsFile), logger: ctx.logger });
        return {
          outputWatermark: summary.asOfHour === null ? null : hourIso(summary.asOfHour),
          details: { runs: summary.runs, items: summary.items, priced: summary.priced },
        };
      },
    },
    {
      name: 'check-semantics',
      dependsOn: ['parse'],
      timeoutMs: 10 * MINUTE,
      due: dailyAfterMidnightUtc,
      async run() {
        const report = await checkSemantics(pool);
        const violated = report.results.filter((r) => r.violations > 0);
        return {
          outputWatermark: null,
          details: { rows: report.rows, violations: Object.fromEntries(violated.map((r) => [r.name, r.violations])) },
          ...(violated.length > 0
            ? { problem: `invariants violated: ${violated.map((r) => `${r.name} (${r.violations})`).join(', ')}` }
            : {}),
        };
      },
    },
  ];
}

/** Once per UTC day: in the first tick of a day it has not run in yet. */
export function dailyAfterMidnightUtc(now: Date, state: JobState | undefined): boolean {
  return !state || state.lastRunAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

/** Newest stored (or parsed) PC source hour as ISO, or null when there is none. */
async function newestHour(pool: pg.Pool, parsed: boolean): Promise<string | null> {
  const { rows } = await pool.query<{ hour: string | null }>(
    `SELECT extract(epoch FROM max(source_hour))::bigint AS hour FROM raw_digests
     WHERE realm = $1 ${parsed ? 'AND parser_version IS NOT NULL' : ''}`,
    [REALM],
  );
  return rows[0]?.hour == null ? null : hourIso(Number(rows[0].hour));
}
