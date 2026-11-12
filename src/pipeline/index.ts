import type pg from 'pg';
import { withPipelineLock, ConcurrentRunError } from '../ingest.ts';
import { silentLogger } from '../log.ts';
import type { Job } from './job.ts';
import { MemoryStateStore, runTick, type TickOptions, type TickResult } from './runner.ts';
import { PgStateStore, readJobStates } from './state.ts';

export * from './job.ts';
export * from './runner.ts';

/**
 * One tick under the pipeline lock, with state in PostgreSQL. Returns null when another tick holds the lock. A dry run
 * reads the stored state but records nothing.
 */
export async function runPipelineTick(pool: pg.Pool, jobs: readonly Job[], options: TickOptions = {}): Promise<TickResult | null> {
  const logger = options.logger ?? silentLogger;
  try {
    return await withPipelineLock(pool, async () => {
      if (options.dryRun) {
        const store = new MemoryStateStore();
        for (const [job, state] of await readJobStates(pool)) store.states.set(job, state);
        return runTick(jobs, store, options);
      }
      const store = new PgStateStore(pool);
      const result = await runTick(jobs, store, options);
      const pruned = await store.prune((options.now ?? (() => new Date()))());
      if (pruned > 0) logger.info('pruned old job runs', { deleted: pruned });
      return result;
    });
  } catch (error) {
    if (error instanceof ConcurrentRunError) {
      logger.warn('another pipeline tick is running; skipped this one');
      return null;
    }
    throw error;
  }
}
