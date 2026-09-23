import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { errorMessage, silentLogger, type Logger } from '../log.ts';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'migrations');

// Arbitrary constant key so concurrent migration runs serialize.
const MIGRATION_LOCK_KEY = 7_319_004;

/**
 * Applies `NNNN_name.sql` files in order, each in its own transaction, and records them in
 * schema_migrations. Refuses to continue if an applied file was edited afterwards.
 */
export async function runMigrations(pool: pg.Pool, dir = MIGRATIONS_DIR, logger: Logger = silentLogger): Promise<string[]> {
  const files = (await readdir(dir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations',
      );
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));
      const newlyApplied: string[] = [];

      for (const file of files) {
        const sql = await readFile(path.join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = applied.get(file);
        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(`Migration ${file} changed after it was applied; add a new migration instead`);
          }
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${errorMessage(error)}`, { cause: error });
        }
        logger.info('applied migration', { version: file });
        newlyApplied.push(file);
      }
      return newlyApplied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
