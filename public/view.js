// Pure presentation logic: API JSON in, display strings out. No DOM access, so node tests can check what the page
// shows against the stored fixtures.

/**
 * @typedef {{ num: string, den: string, value: number }} Rate
 * @typedef {{ name: string, path: string, category: string, named: boolean }} Item
 * @typedef {{
 *   id: string, item: Item, rank: number | null, score?: number | null, eligible: boolean, window_hours: number,
 *   covered_hours: number,
 *   traded_hours: number, coverage: number, persistence: number, turnover_per_hour: number | null,
 *   units_per_hour: number | null, volume: { quote: string, base: string }, rate: Rate | null,
 *   low_rate: Rate | null, high_rate: Rate | null, volatility: number | null
 * }} Market
 * @typedef {{ hour: string, status: string, volume: { quote: string, base: string } | null, rate: Rate | null,
 *   low_rate: Rate | null, high_rate: Rate | null,
 *   stock: { quote: { low: string, high: string }, base: { low: string, high: string } } | null }} HistoryHour
 * @typedef {{ as_of_hour: string | null, source_age_hours: number | null, stale: boolean }} Freshness
 */

export const DASH = '—';

/** The hour statuses of /api/markets/:id/history, in legend order, with what they mean for the chart. */
export const HOUR_STATUSES = /** @type {const} */ ([
  { status: 'traded', label: 'Traded', known: true },
  { status: 'listed', label: 'Listed, no trades', known: true },
  { status: 'inactive', label: 'No activity', known: true },
  { status: 'league-absent', label: 'League not running', known: false },
  { status: 'exchange-down', label: 'Exchange down', known: false },
  { status: 'missing', label: 'No data', known: false },
]);

const PROBLEMS = /** @type {Record<string, string>} */ ({
  no_data: 'No exchange data has been collected yet.',
  stale_source: 'The newest exchange data is more than 3 hours old.',
  last_fetch_failed: 'The last collection attempt failed.',
  parse_failures: 'Some collected hours could not be read.',
  rejected_responses: 'The exchange returned malformed responses in the last 24 hours.',
  metrics_behind: 'Market metrics are older than the newest collected hour.',
  gaps_last_24h: 'Some of the last 24 hours are missing.',
});

/**
 * Compact number with at most one decimal: 13437690 → "13.4M", 40897.9 → "40.9k", 328.57 → "329", 4.058 → "4.1".
 * @param {number | null | undefined} n
 */
export function compact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9, 1)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6, 1)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3, 1)}k`;
  if (abs >= 100) return String(Math.round(n));
  return trim(n, 1);
}

/** @param {number} n @param {number} digits */
function trim(n, digits) {
  return String(Number(n.toFixed(digits)));
}

/**
 * A Chaos rate for display, with one decimal. Items worth at least 1 Chaos read "328.6c"; cheaper ones read as how
 * many you get per Chaos ("14.5 per c"), which is how players quote them.
 * @param {Rate | null} rate
 */
export function rateText(rate) {
  if (!rate || !(rate.value > 0)) return DASH;
  if (rate.value >= 1) return `${rate.value.toFixed(1)}c`;
  return `${(1 / rate.value).toFixed(1)} per c`;
}

/**
 * High minus low, in the unit the prices are shown in: Chaos when the high is at least 1 Chaos ("23.0c"), otherwise
 * items per Chaos ("1.0 per c" between 10.0 and 9.0 per c), where a Chaos difference would round to 0.0.
 * @param {Rate | null} low
 * @param {Rate | null} high
 */
export function differenceText(low, high) {
  if (!low || !high || !(low.value > 0) || !(high.value > 0)) return DASH;
  if (high.value >= 1) return `${(high.value - low.value).toFixed(1)}c`;
  return `${(1 / low.value - 1 / high.value).toFixed(1)} per c`;
}

/**
 * The ranking score, (high − low) / low × Chaos per hour. Uses the API's value when present, otherwise computes it
 * the same way (the history summary has no stored score).
 * @param {Market} m
 */
export function scoreOf(m) {
  if (m.score !== undefined) return m.score;
  if (!m.low_rate || !m.high_rate || m.turnover_per_hour === null || !(m.low_rate.value > 0)) return null;
  return ((m.high_rate.value - m.low_rate.value) / m.low_rate.value) * m.turnover_per_hour;
}

/** @param {number | null | undefined} share 0..1 */
export function percentText(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return DASH;
  return `${Math.round(share * 100)}%`;
}

/** Volatility as a ± percentage of the rate: 0.0101 → "±1.0%". @param {number | null} v */
export function volatilityText(v) {
  if (v === null || !Number.isFinite(v)) return DASH;
  return `±${(v * 100).toFixed(1)}%`;
}

/** @param {number | null} hours */
export function ageText(hours) {
  if (hours === null || !Number.isFinite(hours)) return DASH;
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
  if (hours < 48) return `${trim(hours, 1)} h`;
  return `${trim(hours / 24, 1)} days`;
}

/** "2026-04-15T12:00:00.000Z" → "2026-04-15 12:00 UTC". @param {string | null} iso */
export function hourText(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : DASH;
}

/** One table row, every cell as display text. @param {Market} m */
export function marketRow(m) {
  return {
    id: m.id,
    rank: m.rank === null ? DASH : String(m.rank),
    name: m.item.name,
    category: m.item.category,
    unnamed: !m.item.named,
    // The lowest and highest price actually paid in the window, in Chaos per item.
    low: rateText(m.low_rate),
    high: rateText(m.high_rate),
    range: differenceText(m.low_rate, m.high_rate),
    score: compact(scoreOf(m)),
    turnover: m.turnover_per_hour === null ? DASH : `${compact(m.turnover_per_hour)}c/h`,
    units: m.units_per_hour === null ? DASH : `${compact(m.units_per_hour)}/h`,
    traded: `${m.traded_hours}/${m.covered_hours} h`,
    coverage: percentText(m.coverage),
    volatility: volatilityText(m.volatility),
    eligible: m.eligible,
    lowCoverage: m.coverage < 0.75,
  };
}

/**
 * The data-freshness banner from /api/status.
 * @param {{ data: { state: string, problems: string[], source: Freshness } }} status
 */
export function statusBanner(status) {
  const { state, problems, source } = status.data;
  const level = problems.includes('no_data') ? 'down' : source.stale ? 'stale' : state === 'ok' ? 'ok' : 'degraded';
  const asOf = source.as_of_hour
    ? `Data up to ${hourText(source.as_of_hour)} (${ageText(source.source_age_hours)} old)`
    : 'No data yet';
  return { level, text: asOf, problems: problems.map((p) => PROBLEMS[p] ?? p) };
}

/**
 * Series for the history chart. Hours without trades are null, so the line breaks instead of dropping to zero.
 * @param {{ hours: HistoryHour[] }} history
 */
export function historySeries(history) {
  const x = [];
  const low = [];
  const high = [];
  const turnover = [];
  for (const h of history.hours) {
    x.push(Date.parse(h.hour) / 1000);
    low.push(h.low_rate?.value ?? null);
    high.push(h.high_rate?.value ?? null);
    // Covered hours without trades are a real zero; unknown hours stay empty.
    const known = HOUR_STATUSES.find((s) => s.status === h.status)?.known ?? false;
    turnover.push(h.volume ? Number(h.volume.quote) : known ? 0 : null);
  }
  return { x, low, high, turnover, statuses: history.hours.map((h) => h.status) };
}

/** Counts of each hour status, in legend order. @param {string[]} statuses */
export function statusCounts(statuses) {
  return HOUR_STATUSES.map(({ status, label }) => ({
    status,
    label,
    count: statuses.filter((s) => s === status).length,
  })).filter((s) => s.count > 0);
}

// ---- URL state ------------------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   league: string, window: '1h' | '6h' | '24h', scope: 'eligible' | 'all',
 *   sort: 'rank' | 'score' | 'turnover' | 'units' | 'persistence' | 'volatility' | 'low' | 'high' | 'range' | 'name',
 *   order: '' | 'asc' | 'desc',
 *   q: string, offset: number, market: string, history: '24h' | '7d' | '30d'
 * }} State
 */

/** @type {Readonly<State>} */
export const DEFAULT_STATE = Object.freeze({
  league: '',
  window: '24h',
  scope: 'eligible',
  sort: 'rank',
  order: '',
  q: '',
  offset: 0,
  market: '',
  history: '7d',
});

const CHOICES = /** @type {Record<string, readonly string[]>} */ ({
  window: ['1h', '6h', '24h'],
  scope: ['eligible', 'all'],
  sort: ['rank', 'score', 'turnover', 'units', 'persistence', 'volatility', 'low', 'high', 'range', 'name'],
  order: ['', 'asc', 'desc'],
  history: ['24h', '7d', '30d'],
});

/**
 * Page state from the address bar; unknown or invalid values fall back to defaults, so any shared link opens.
 * @param {string} search
 * @returns {State}
 */
export function stateFromSearch(search) {
  const params = new URLSearchParams(search);
  /** @type {Record<string, string | number>} */
  const state = { ...DEFAULT_STATE };
  for (const key of Object.keys(DEFAULT_STATE)) {
    const value = params.get(key);
    if (value === null) continue;
    if (key === 'offset') state.offset = /^\d{1,5}$/.test(value) ? Number(value) : 0;
    else if (!CHOICES[key] || CHOICES[key].includes(value)) state[key] = value.slice(0, 200);
  }
  return /** @type {State} */ (state);
}

/** The address-bar query for a state, omitting defaults. @param {State} state */
export function searchFromState(state) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (value !== /** @type {Record<string, unknown>} */ (DEFAULT_STATE)[key] && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Query parameters for /api/markets from the page state. @param {State} state @param {number} limit */
export function marketQuery(state, limit) {
  /** @type {Record<string, string>} */
  const query = {
    league: state.league,
    window: state.window,
    scope: state.scope,
    sort: state.sort,
    limit: String(limit),
    offset: String(state.offset),
  };
  if (state.order) query.order = state.order;
  if (state.q) query.q = state.q;
  return query;
}
