export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function formatValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return /^[\w.:/@+-]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/** Writes one line per event: `<time> <LEVEL> <message> key=value ...`. */
export function createLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  const log = (level: string, message: string, fields: LogFields = {}) => {
    const pairs = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ` ${key}=${formatValue(value)}`)
      .join('');
    write(`${new Date().toISOString()} ${level} ${message}${pairs}\n`);
  };
  return {
    info: (message, fields) => log('INFO', message, fields),
    warn: (message, fields) => log('WARN', message, fields),
    error: (message, fields) => log('ERROR', message, fields),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** A readable message for any thrown value, including AggregateError (e.g. connection refused). */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  if (error instanceof AggregateError && error.errors.length > 0) {
    return [...new Set(error.errors.map(errorMessage))].join('; ');
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}
