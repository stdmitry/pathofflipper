// Pure presentation logic: API JSON in, display strings out. No DOM access, so node tests can check what the page
// shows against the stored fixtures.

/**
 * @typedef {{ num: string, den: string, value: number }} Rate
 * @typedef {{ name: string, path: string, category: string, named: boolean }} Item
 * @typedef {{
 *   id: string, item: Item, rank: number | null, score?: number | null, gold_per_flip?: number | null,
 *   quote_per_1k_gold?: number | null, held?: Held | null, eligible: boolean, window_hours: number,
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

/** @typedef {'chaos' | 'divine'} Quote */
/** The table's view: markets quoted in one currency, or the Chaos → Divine flip. @typedef {Quote | 'flip'} View */

/** How each quote currency reads: after a price, in "per …" and after a per-hour amount. */
export const QUOTE_UNITS = /** @type {const} */ ({
  chaos: { name: 'Chaos', price: 'c', per: 'c', perHour: 'c/h', column: 'Chaos/h', minPerHour: '100c/h' },
  divine: { name: 'Divine', price: ' div', per: 'div', perHour: ' div/h', column: 'Div/h', minPerHour: '0.3 div/h' },
});

/**
 * A price in the quote currency, with one decimal. Items worth at least 1 unit of the quote read "328.6c" or
 * "2.3 div"; cheaper ones read as how many you get per unit ("14.5 per c"), which is how players quote them.
 * @param {Rate | null} rate
 * @param {Quote} [quote]
 */
export function rateText(rate, quote = 'chaos') {
  if (!rate || !(rate.value > 0)) return DASH;
  const unit = QUOTE_UNITS[quote];
  if (rate.value >= 1) return `${rate.value.toFixed(1)}${unit.price}`;
  return `${(1 / rate.value).toFixed(1)} per ${unit.per}`;
}

/**
 * High minus low, in the unit the prices are shown in: the quote when the high is at least 1 unit ("23.0c"),
 * otherwise items per quote unit ("1.0 per c" between 10.0 and 9.0 per c), where a difference would round to 0.0.
 * @param {Rate | null} low
 * @param {Rate | null} high
 * @param {Quote} [quote]
 */
export function differenceText(low, high, quote = 'chaos') {
  if (!low || !high || !(low.value > 0) || !(high.value > 0)) return DASH;
  const unit = QUOTE_UNITS[quote];
  if (high.value >= 1) return `${(high.value - low.value).toFixed(1)}${unit.price}`;
  return `${(1 / low.value - 1 / high.value).toFixed(1)} per ${unit.per}`;
}

/**
 * The ranking score, (high − low) / low × turnover per hour × quote per 1k gold. Uses the API's value when present,
 * otherwise computes it the same way (the history summary has no stored score).
 * @param {Market} m
 */
export function scoreOf(m) {
  if (m.score !== undefined) return m.score;
  const perGold = m.quote_per_1k_gold ?? null;
  if (!m.low_rate || !m.high_rate || m.turnover_per_hour === null || perGold === null || !(m.low_rate.value > 0)) {
    return null;
  }
  return ((m.high_rate.value - m.low_rate.value) / m.low_rate.value) * m.turnover_per_hour * perGold;
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

/** @typedef {{ hours: number, checked: number, lookback: number, drift: number | null, moving: boolean }} Held */

/**
 * The held check: "5/6" means 5 of the 6 previous hours showed at least half the newest hour's margin. Only the 1h
 * window has it.
 * @param {Held | null | undefined} held
 */
export function heldText(held) {
  if (!held) return DASH;
  return `${held.hours}/${held.lookback}${held.moving ? ' · moving' : ''}`;
}

/** One table row, every cell as display text. @param {Market} m @param {Quote} [quote] */
export function marketRow(m, quote = 'chaos') {
  return {
    id: m.id,
    rank: m.rank === null ? DASH : String(m.rank),
    name: m.item.name,
    category: m.item.category,
    unnamed: !m.item.named,
    // The lowest and highest price actually paid in the window, in quote units per item.
    low: rateText(m.low_rate, quote),
    high: rateText(m.high_rate, quote),
    range: differenceText(m.low_rate, m.high_rate, quote),
    score: compact(scoreOf(m)),
    held: heldText(m.held),
    moving: m.held?.moving ?? false,
    // Gold to buy one unit at the low and sell it at the high, and what that round trip earns per 1,000 gold.
    gold: compact(m.gold_per_flip),
    perGold:
      m.quote_per_1k_gold === null || m.quote_per_1k_gold === undefined
        ? DASH
        : `${m.quote_per_1k_gold.toFixed(1)}${QUOTE_UNITS[quote].price}`,
    turnover: m.turnover_per_hour === null ? DASH : `${compact(m.turnover_per_hour)}${QUOTE_UNITS[quote].perHour}`,
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

/**
 * @typedef {{
 *   id: string, item: Item, rank: number | null, eligible: boolean, buy: Rate | null, sell: Rate | null,
 *   sell_chaos: number | null, margin_chaos: number | null, margin_share: number | null,
 *   turnover_per_hour: number | null, gold_per_flip: number | null, chaos_per_1k_gold: number | null,
 *   score: number | null, held: Held | null
 * }} FlipMarket
 */

/** One Chaos → Divine flip row, every cell as display text. @param {FlipMarket} f */
export function flipRow(f) {
  const chaos = (/** @type {number | null} */ n) => (n === null ? DASH : `${n.toFixed(1)}c`);
  return {
    id: f.id,
    rank: f.rank === null ? DASH : String(f.rank),
    name: f.item.name,
    category: f.item.category,
    unnamed: !f.item.named,
    buy: rateText(f.buy, 'chaos'),
    sell: rateText(f.sell, 'divine'),
    sellChaos: chaos(f.sell_chaos),
    margin: chaos(f.margin_chaos),
    marginPct: f.margin_share === null ? DASH : `${Math.round(f.margin_share * 100)}%`,
    score: compact(f.score),
    gold: compact(f.gold_per_flip),
    perGold: chaos(f.chaos_per_1k_gold),
    turnover: f.turnover_per_hour === null ? DASH : `${compact(f.turnover_per_hour)}c/h`,
    held: heldText(f.held),
    moving: f.held?.moving ?? false,
    eligible: f.eligible,
    loss: f.margin_chaos !== null && f.margin_chaos <= 0,
  };
}

// ---- URL state ------------------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   league: string, quote: View, window: '1h' | '24h', scope: 'eligible' | 'all',
 *   sort: 'rank' | 'score' | 'gold' | 'per_gold' | 'turnover' | 'units' | 'persistence' | 'volatility' | 'low' | 'high'
 *     | 'range' | 'name' | 'margin' | 'margin_pct' | 'buy' | 'sell' | 'held',
 *   order: '' | 'asc' | 'desc',
 *   q: string, offset: number, market: string, history: '24h' | '7d' | '30d'
 * }} State
 */

/** @type {Readonly<State>} */
export const DEFAULT_STATE = Object.freeze({
  league: '',
  quote: 'chaos',
  window: '1h',
  scope: 'eligible',
  sort: 'rank',
  order: '',
  q: '',
  offset: 0,
  market: '',
  history: '7d',
});

const CHOICES = /** @type {Record<string, readonly string[]>} */ ({
  quote: ['chaos', 'divine', 'flip'],
  window: ['1h', '24h'],
  scope: ['eligible', 'all'],
  sort: [
    'rank', 'score', 'gold', 'per_gold', 'turnover', 'units', 'persistence', 'volatility', 'low', 'high', 'range', 'name',
    'margin', 'margin_pct', 'buy', 'sell', 'held',
  ],
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

/** Query parameters for /api/flips from the page state. @param {State} state @param {number} limit */
export function flipQuery(state, limit) {
  const { quote: _quote, ...query } = marketQuery(state, limit);
  return query;
}

/** Query parameters for /api/markets from the page state. @param {State} state @param {number} limit */
export function marketQuery(state, limit) {
  /** @type {Record<string, string>} */
  const query = {
    league: state.league,
    quote: state.quote,
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

/** The two pages share the league and window; each page's tab links to the other with them. @param {{ league: string, window: string }} state */
export function navSearch(state) {
  const params = new URLSearchParams();
  if (state.league) params.set('league', state.league);
  if (state.window !== '1h') params.set('window', state.window);
  const text = params.toString();
  return text ? `?${text}` : '';
}

// ---- Opportunities --------------------------------------------------------------------------------------------------

/**
 * @typedef {'flip_chaos' | 'flip_divine' | 'trade_c_d' | 'runegraft'} Kind
 * @typedef {{ side: 'buy' | 'sell' | 'expect', label: string, item: Item | null, quantity: number, price: number, quote: Quote }} Leg
 * @typedef {{
 *   id: string, kind: Kind, title: string, item: Item, legs: Leg[], cost_chaos: number, return_chaos: number,
 *   profit_chaos: number, margin_share: number, gold_per_cycle: number | null, chaos_per_1k_gold: number | null,
 *   cycles_per_hour: number | null, chaos_per_hour_ceiling: number | null, basis: 'range' | 'ev' | 'ev_estimate',
 *   eligible: boolean, rank: number | null, warnings: string[], detail: Record<string, any>
 * }} Opportunity
 */

/** Kinds in display order: the label in the table and the label of the filter chip. */
export const KINDS = /** @type {const} */ ([
  { kind: 'flip_chaos', label: 'Flip · Chaos', chip: 'Chaos flips' },
  { kind: 'flip_divine', label: 'Flip · Divine', chip: 'Divine flips' },
  { kind: 'trade_c_d', label: 'Trade · c → div', chip: 'Chaos → Divine trades' },
  { kind: 'runegraft', label: 'Runegraft 3:1', chip: 'Runegraft 3:1' },
]);

/** What each basis means, as a badge and its tooltip. */
export const BASIS = /** @type {const} */ ({
  range: { label: 'Range', title: "From the window's lowest and highest executed prices: an upper bound, not a spread you can capture" },
  ev: { label: 'EV', title: 'Expected value of a random outcome; any single conversion can lose' },
  ev_estimate: { label: 'EV est.', title: 'Expected value from incomplete probabilities or prices; treat as rough' },
});

/**
 * A Chaos amount in the chosen display currency: "12.3c", "1.2k c", or "0.04 div" at the window's rate.
 * @param {number | null} chaos
 * @param {Quote} unit
 * @param {number | null} divineRate
 */
export function moneyText(chaos, unit, divineRate) {
  if (chaos === null || !Number.isFinite(chaos)) return DASH;
  if (unit === 'divine') {
    if (!divineRate) return DASH;
    const div = chaos / divineRate;
    return `${Math.abs(div) >= 100 ? compact(div) : div.toFixed(2)} div`;
  }
  return Math.abs(chaos) >= 1000 ? `${compact(chaos)}c` : `${chaos.toFixed(1)}c`;
}

/** What the player does, from the legs: "Buy at 12.0c · sell at 15.0c". @param {Leg[]} legs */
export function legsText(legs) {
  return legs
    .map((leg, i) => {
      const verb = leg.side === 'buy' ? 'buy' : leg.side === 'sell' ? 'sell' : 'get one worth';
      const text =
        leg.side === 'expect'
          ? `${verb} ≈ ${moneyText(leg.price, 'chaos', null)}`
          : `${verb} ${leg.quantity > 1 ? `${leg.quantity} at ` : 'at '}${rateText({ num: '', den: '', value: leg.price }, leg.quote)}`;
      return i === 0 ? text[0].toUpperCase() + text.slice(1) : text;
    })
    .join(' · ');
}

/**
 * One opportunity row, every cell as display text.
 * @param {Opportunity} o
 * @param {Quote} [unit] display currency
 * @param {number | null} [divineRate] Chaos per Divine, for the Divine display
 */
export function opportunityRow(o, unit = 'chaos', divineRate = null) {
  const money = (/** @type {number | null} */ n) => moneyText(n, unit, divineRate);
  return {
    id: o.id,
    rank: o.rank === null ? DASH : String(o.rank),
    kind: KINDS.find((k) => k.kind === o.kind)?.label ?? o.kind,
    name: o.title,
    category: legsText(o.legs),
    unnamed: !o.item.named,
    cost: money(o.cost_chaos),
    ret: money(o.return_chaos),
    profit: money(o.profit_chaos),
    loss: o.profit_chaos <= 0,
    marginPct: percentText(o.margin_share),
    perGold: money(o.chaos_per_1k_gold),
    gold: compact(o.gold_per_cycle),
    cycles: o.cycles_per_hour === null ? DASH : `${compact(o.cycles_per_hour)}/h`,
    ceiling: o.chaos_per_hour_ceiling === null ? DASH : `${money(o.chaos_per_hour_ceiling)}/h`,
    basis: BASIS[o.basis].label,
    basisTitle: BASIS[o.basis].title,
    basisKind: o.basis,
    warnings: o.warnings.join('\n'),
    warningCount: o.warnings.length,
    eligible: o.eligible,
  };
}

/** Where a flip or trade opens on the Flipping page; null for other kinds. @param {Opportunity} o @param {{ league: string, window: string }} state */
export function flippingHref(o, state) {
  const quote = { flip_chaos: 'chaos', flip_divine: 'divine', trade_c_d: 'flip' }[/** @type {string} */ (o.kind)];
  const market = o.detail.market_id ?? o.detail.buy_market_id;
  if (!quote || !market) return null;
  const params = new URLSearchParams(navSearch(state));
  if (quote !== 'chaos') params.set('quote', quote);
  params.set('market', market);
  return `/flipping?${params}`;
}

/**
 * The Opportunities page state. Its parameter names avoid the dashboard's quote, market, history and offset, which
 * redirect a request for / to /flipping.
 * @typedef {{
 *   league: string, window: '1h' | '24h', kinds: string, scope: 'eligible' | 'all', q: string, min_profit: string,
 *   sort: 'ceiling' | 'profit' | 'margin_pct' | 'per_gold' | 'cycles' | 'name', order: '' | 'asc' | 'desc',
 *   page: number, open: string, unit: Quote, chart: '24h' | '7d' | '30d'
 * }} OppState
 */

/** @type {Readonly<OppState>} */
export const OPP_DEFAULT_STATE = Object.freeze({
  league: '',
  window: '1h',
  kinds: '',
  scope: 'eligible',
  q: '',
  min_profit: '',
  sort: 'ceiling',
  order: '',
  page: 0,
  open: '',
  unit: 'chaos',
  chart: '7d',
});

const OPP_CHOICES = /** @type {Record<string, readonly string[]>} */ ({
  window: ['1h', '24h'],
  scope: ['eligible', 'all'],
  sort: ['ceiling', 'profit', 'margin_pct', 'per_gold', 'cycles', 'name'],
  order: ['', 'asc', 'desc'],
  unit: ['chaos', 'divine'],
  chart: ['24h', '7d', '30d'],
});

/**
 * Opportunities state from the address bar; invalid values fall back to defaults, so any shared link opens. `kinds`
 * keeps only known kinds, in display order; empty means all.
 * @param {string} search
 * @returns {OppState}
 */
export function oppStateFromSearch(search) {
  const params = new URLSearchParams(search);
  /** @type {Record<string, string | number>} */
  const state = { ...OPP_DEFAULT_STATE };
  for (const key of Object.keys(OPP_DEFAULT_STATE)) {
    const value = params.get(key);
    if (value === null) continue;
    if (key === 'page') state.page = /^\d{1,3}$/.test(value) ? Number(value) : 0;
    else if (key === 'kinds') state.kinds = selectedKinds(value).join(',');
    else if (key === 'min_profit') state.min_profit = /^-?\d{1,9}(\.\d{1,6})?$/.test(value) ? value : '';
    else if (!OPP_CHOICES[key] || OPP_CHOICES[key].includes(value)) state[key] = value.slice(0, 200);
  }
  if (state.kinds === KINDS.map((k) => k.kind).join(',')) state.kinds = '';
  return /** @type {OppState} */ (state);
}

/** The address-bar query for an Opportunities state, omitting defaults. @param {OppState} state */
export function searchFromOppState(state) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (value !== /** @type {Record<string, unknown>} */ (OPP_DEFAULT_STATE)[key] && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Known kinds in a comma list, in display order; all kinds for an empty list. @param {string} kinds @returns {Kind[]} */
export function selectedKinds(kinds) {
  const chosen = new Set(kinds.split(','));
  const known = KINDS.map((k) => k.kind).filter((k) => chosen.has(k));
  return kinds === '' ? KINDS.map((k) => k.kind) : known;
}

/** Query parameters for /api/opportunities. @param {OppState} state @param {number} limit */
export function opportunityQuery(state, limit) {
  /** @type {Record<string, string>} */
  const query = {
    league: state.league,
    window: state.window,
    scope: state.scope,
    sort: state.sort,
    limit: String(limit),
    offset: String(state.page * limit),
  };
  if (state.order) query.order = state.order;
  if (state.q) query.q = state.q;
  if (state.kinds) query.kinds = state.kinds;
  if (state.min_profit) query.min_profit = state.min_profit;
  return query;
}
