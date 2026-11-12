import type pg from 'pg';
import type { JobState } from './job.ts';
import { applyRecord, isRecorded, type JobRunRecord, type StateStore } from './runner.ts';

/** job_runs older than this are deleted at the end of each tick. */
export const RUN_RETENTION_DAYS = 30;

interface JobStateRow {
  job: string;
  last_status: string;
  last_run_at: Date;
  input_watermark: string | null;
  output_watermark: string | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  consecutive_failures: number;
}

export async function readJobStates(pool: pg.Pool): Promise<Map<string, JobState>> {
  const { rows } = await pool.query<JobStateRow>('SELECT * FROM job_state ORDER BY job');
  return new Map(
    rows.map((r) => [
      r.job,
      {
        lastStatus: r.last_status,
        lastRunAt: r.last_run_at,
        inputWatermark: r.input_watermark,
        outputWatermark: r.output_watermark,
        lastSuccessAt: r.last_success_at,
        lastError: r.last_error,
        lastErrorAt: r.last_error_at,
        consecutiveFailures: r.consecutive_failures,
      },
    ]),
  );
}

/** job_state and job_runs in PostgreSQL. Only one tick runs at a time (pipeline lock), so read-modify-write is safe. */
export class PgStateStore implements StateStore {
  private readonly pool: pg.Pool;
  private states = new Map<string, JobState>();

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async load(): Promise<Map<string, JobState>> {
    this.states = await readJobStates(this.pool);
    return new Map(this.states);
  }

  async record(run: JobRunRecord): Promise<void> {
    const next = applyRecord(this.states.get(run.job), run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO job_state (job, last_status, last_run_at, input_watermark, output_watermark, last_success_at,
           last_error, last_error_at, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (job) DO UPDATE SET last_status = EXCLUDED.last_status, last_run_at = EXCLUDED.last_run_at,
           input_watermark = EXCLUDED.input_watermark, output_watermark = EXCLUDED.output_watermark,
           last_success_at = EXCLUDED.last_success_at, last_error = EXCLUDED.last_error,
           last_error_at = EXCLUDED.last_error_at, consecutive_failures = EXCLUDED.consecutive_failures`,
        [
          run.job,
          next.lastStatus,
          next.lastRunAt,
          next.inputWatermark,
          next.outputWatermark,
          next.lastSuccessAt,
          next.lastError,
          next.lastErrorAt,
          next.consecutiveFailures,
        ],
      );
      if (isRecorded(run.status)) {
        await client.query(
          `INSERT INTO job_runs (tick_id, job, status, input_watermark, output_watermark, started_at, finished_at, details, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            run.tickId,
            run.job,
            run.status,
            run.inputWatermark,
            run.outputWatermark,
            run.startedAt,
            run.finishedAt,
            run.details === null ? null : JSON.stringify(run.details),
            run.error,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    this.states.set(run.job, next);
  }

  /** Deletes job_runs older than the retention period; returns how many. */
  async prune(now: Date): Promise<number> {
    const result = await this.pool.query(`DELETE FROM job_runs WHERE started_at < $1::timestamptz - make_interval(days => $2)`, [
      now,
      RUN_RETENTION_DAYS,
    ]);
    return result.rowCount ?? 0;
  }
}
