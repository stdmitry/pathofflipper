export const APP_NAME = 'pathofflipper';
export const APP_VERSION = '0.1.0';

/** Only PoE 1 PC is collected. Console realms (xbox, sony) are rejected, not fetched. */
export const REALM = 'pc';
export type Realm = typeof REALM;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function parseRealm(value: string): Realm {
  if (value !== REALM) {
    throw new ConfigError(`Realm "${value}" is not supported; only PoE 1 PC ("${REALM}") is collected`);
  }
  return REALM;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set; copy .env.example to .env and fill it in`);
  return value;
}

export function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseNonNegativeInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/** `<app>/<version> (contact: <contact>)`, per https://www.pathofexile.com/developer/docs#guidelines */
export function userAgent(contact: string): string {
  return `${APP_NAME}/${APP_VERSION} (contact: ${contact})`;
}
