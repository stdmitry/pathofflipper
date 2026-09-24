// Thin client for the read API. Every failure becomes an ApiError, so the page has one error path.

export class ApiError extends Error {
  /** @param {number} status 0 when the server could not be reached @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * GETs an API path with query parameters and returns the parsed JSON body.
 * @param {string} path
 * @param {Record<string, string>} [query]
 * @param {AbortSignal} [signal] aborted requests reject with the AbortError untouched
 * @returns {Promise<any>}
 */
export async function api(path, query = {}, signal) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Cannot reach the server. Is `npm run serve` running?');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'http', body?.error?.message ?? `HTTP ${response.status}`);
  }
  return body;
}

/** @param {unknown} error */
export function isAbort(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}
