import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { createLogger, errorMessage } from '../log.ts';
import { checkSemantics } from '../semantics-check.ts';

const USAGE = `Check stored pair_hours against the field semantics the market metrics rely on.

Usage: npm run check-semantics [-- --league <name>]

  --league <name>   Check one PoE 1 PC league instead of all stored data.

Run it after a new league starts. A violation means the API's meaning changed or was misread: stop relying on
metrics built on that invariant and update specs/exchange-api-observations.md.

Exit codes: 0 every invariant holds, 1 violations found or the check failed, 2 invalid configuration.`;

const logger = createLogger();

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: { league: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(USAGE);
    return true;
  }
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
  try {
    const report = await checkSemantics(pool, values.league);
    for (const result of report.results) {
      const log = result.violations === 0 ? logger.info : logger.error;
      log(result.violations === 0 ? 'invariant holds' : 'invariant violated', {
        invariant: result.name,
        violations: result.violations,
        rule: result.description,
      });
    }
    logger.info('check finished', { league: values.league, rows: report.rows });
    return report.results.every((result) => result.violations === 0);
  } finally {
    await pool.end();
  }
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'check failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
