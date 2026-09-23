import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { runMigrations } from '../db/migrate.ts';
import { createLogger, errorMessage } from '../log.ts';

const logger = createLogger();

try {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  try {
    const applied = await runMigrations(pool, undefined, logger);
    logger.info(applied.length ? 'migrations applied' : 'database already up to date', { applied: applied.length });
  } finally {
    await pool.end();
  }
} catch (error) {
  logger.error('migration failed', { error: errorMessage(error) });
  process.exitCode = error instanceof ConfigError ? 2 : 1;
}
