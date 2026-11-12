import { parseArgs } from 'node:util';
import pg from 'pg';
import { ConfigError, requireEnv } from '../config.ts';
import { hourIso } from '../exchange/hours.ts';
import { createLogger, errorMessage } from '../log.ts';
import { WINDOWS, type WindowHours } from '../market/metrics.ts';
import {
  DEFAULT_MARGIN,
  DEFAULT_MIN_OUTCOME_PRICE,
  expectedValue,
  formatReport,
  loadWeights,
  RUNEGRAFT_WEIGHTS_FILE,
} from '../market/runegraft.ts';
import { runegraftPrices } from '../runegraft-prices.ts';

const USAGE = `Find Runegrafts priced below the expected value of the random 3:1 vendor conversion.

Usage: npm run runegraft -- --league <name> [options]

  --league <name>      League to scan (required).
  --window <1|24>      Price window in hours (default 24).
  --margin <share>     Safety margin below break-even, 0 to <1 (default ${DEFAULT_MARGIN}).
  --min-price <chaos>  Outcomes must be priced strictly above this to count toward EV (default ${DEFAULT_MIN_OUTCOME_PRICE}).
  --weights <file>     Outcome probabilities (default data/runegraft-weights.json).
  --assume-uniform     Share the probability left over by known outcomes equally among unknown ones (an assumption).

Prices come from the stored Chaos metrics snapshot; run npm run metrics first. Buy price is the lowest executed
Chaos price in the window and outcome value is the volume-weighted price. Gold, fees and time are not included.
Spec: specs/runegraft-conversion-mvp-spec.md.

Exit codes: 0 reported, 1 failed, 2 invalid configuration.`;

const logger = createLogger();

function parseNumber(name: string, value: string, check: (n: number) => boolean, range: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || !check(parsed)) throw new ConfigError(`${name} must be ${range}, got "${value}"`);
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      league: { type: 'string' },
      window: { type: 'string', default: '24' },
      margin: { type: 'string', default: String(DEFAULT_MARGIN) },
      'min-price': { type: 'string', default: String(DEFAULT_MIN_OUTCOME_PRICE) },
      weights: { type: 'string', default: RUNEGRAFT_WEIGHTS_FILE },
      'assume-uniform': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.league) throw new ConfigError('--league is required');
  const windowHours = Number(values.window) as WindowHours;
  if (!(WINDOWS as readonly number[]).includes(windowHours)) throw new ConfigError(`--window must be one of ${WINDOWS.join(', ')}`);
  const margin = parseNumber('--margin', values.margin, (n) => n >= 0 && n < 1, 'a number from 0 to below 1');
  const minOutcomePrice = parseNumber('--min-price', values['min-price'], (n) => n >= 0, 'a non-negative number');

  let weights;
  try {
    weights = await loadWeights(values.weights);
  } catch (error) {
    throw new ConfigError(errorMessage(error));
  }

  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
  try {
    const { asOfHour, prices } = await runegraftPrices(pool, values.league, windowHours);
    if (asOfHour === null) throw new Error('no Chaos metrics snapshot; run npm run metrics first');
    const evResult = expectedValue(weights, prices, { minOutcomePrice, assumeUniformUnknown: values['assume-uniform'] });
    console.log(
      formatReport({
        league: values.league,
        windowHours,
        asOfIso: hourIso(asOfHour),
        margin,
        minOutcomePrice,
        weights,
        prices,
        evResult,
      }),
    );
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const configError = error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
  logger.error(configError ? 'invalid configuration' : 'runegraft scan failed', { error: errorMessage(error) });
  process.exitCode = configError ? 2 : 1;
}
