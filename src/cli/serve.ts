import { parseArgs } from 'node:util';
import pg from 'pg';
import { createApiServer } from '../api/server.ts';
import { ConfigError, parsePositiveInt, requireEnv } from '../config.ts';
import { createLogger, errorMessage } from '../log.ts';

const USAGE = `Serve the read API over stored exchange history and metrics.

Usage: npm run serve [-- --port <n>] [-- --host <address>]

  --port <n>          Port to listen on (default: API_PORT or 8080).
  --host <address>    Address to bind (default: API_HOST or 127.0.0.1).

Endpoints: GET /api/leagues, /api/markets, /api/markets/:id/history, /api/status. See README: Read API.
The API only reads PostgreSQL; it never calls the exchange.`;

const logger = createLogger();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { port: { type: 'string' }, host: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const port = parsePositiveInt('--port', values.port ?? process.env.API_PORT ?? '8080');
  const host = values.host ?? process.env.API_HOST ?? '127.0.0.1';
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 5 });
  pool.on('error', (error) => logger.error('idle database connection failed', { error: errorMessage(error) }));

  const server = createApiServer(pool, { logger });
  const stop = () => {
    logger.info('shutting down');
    server.close(() => void pool.end());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  logger.info('listening', { url: `http://${host}:${port}/api/status` });
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'serve failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
