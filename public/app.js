// The dashboard: page state lives in the address bar, data comes from the read API, text from view.js.
import { api, ApiError, isAbort } from './api.js';
import { drawHistory } from './chart.js';
import * as view from './view.js';

const PAGE_SIZE = 50;

/**
 * A table column: its header, the sort key it maps to (if sortable) and how a display row fills it.
 * @typedef {{ label: string, title: string, sort?: view.State['sort'], num?: boolean, cell: (r: any) => Node | string, cls?: (r: any) => string }} Column
 */

/** The item cell: a button opening the detail, and the category. @param {{ id: string, name: string, category: string, unnamed: boolean }} r */
function itemCell(r) {
  const open = el('button', { type: 'button', class: 'item', 'data-id': r.id }, r.name);
  if (r.unnamed) open.title = 'No display name known; showing its internal id';
  return el('span', {}, open, el('span', { class: 'category' }, r.category));
}

/** @param {view.Quote} quote @returns {Column[]} */
function marketColumns(quote) {
  const unit = view.QUOTE_UNITS[quote];
  return [
    { label: 'Rank', title: 'Position by score among eligible markets', sort: 'rank', num: true, cell: (r) => r.rank },
    { label: 'Item', title: '', sort: 'name', cell: itemCell },
    { label: 'Low', title: 'Lowest price paid in a trade during the window', sort: 'low', num: true, cell: (r) => r.low, cls: () => 'strong' },
    { label: 'High', title: 'Highest price paid in a trade during the window', sort: 'high', num: true, cell: (r) => r.high, cls: () => 'strong' },
    { label: 'High − Low', title: 'Highest minus lowest price paid; not a spread you can capture', sort: 'range', num: true, cell: (r) => r.range },
    { label: 'Score', title: `(High − Low) / Low × ${unit.column} × Per 1k gold`, sort: 'score', num: true, cell: (r) => r.score, cls: () => 'strong' },
    { label: 'Gold/flip', title: "Gold to buy one unit at Low and sell it at High; an order costs the wanted item's fee per unit wanted", sort: 'gold', num: true, cell: (r) => r.gold },
    { label: 'Per 1k gold', title: 'What that flip earns per 1,000 gold; an upper bound, since Low and High are extremes', sort: 'per_gold', num: true, cell: (r) => r.perGold },
    { label: unit.column, title: `${unit.name} traded per covered hour`, sort: 'turnover', num: true, cell: (r) => r.turnover },
    { label: 'Units/h', title: 'Units of the item traded per covered hour', sort: 'units', num: true, cell: (r) => r.units },
    { label: 'Traded', title: 'Hours with trades / hours with data', sort: 'persistence', num: true, cell: (r) => r.traded },
    { label: 'Coverage', title: 'Hours with data / hours in the window', num: true, cell: (r) => r.coverage, cls: (r) => (r.lowCoverage ? 'warn' : '') },
    { label: 'Volatility', title: 'Spread of hourly rates, weighted by volume', sort: 'volatility', num: true, cell: (r) => r.volatility },
  ];
}

/** @type {Column[]} */
const FLIP_COLUMNS = [
  { label: 'Rank', title: 'Position by score among flips eligible in both markets with a positive margin', sort: 'rank', num: true, cell: (r) => r.rank },
  { label: 'Item', title: '', sort: 'name', cell: itemCell },
  { label: 'Buy', title: 'Lowest Chaos price paid in the Chaos market during the window', sort: 'buy', num: true, cell: (r) => r.buy, cls: () => 'strong' },
  { label: 'Sell', title: 'Highest Divine price paid in the Divine market during the window', sort: 'sell', num: true, cell: (r) => r.sell, cls: () => 'strong' },
  { label: 'Sell in c', title: "The Divine price in Chaos, at the window's Chaos/Divine rate", num: true, cell: (r) => r.sellChaos },
  { label: 'Margin', title: 'Sell in Chaos minus buy, per unit; an upper bound', sort: 'margin', num: true, cell: (r) => r.margin, cls: (r) => (r.loss ? 'warn' : 'strong') },
  { label: 'Margin %', title: 'Margin / buy', sort: 'margin_pct', num: true, cell: (r) => r.marginPct },
  { label: 'Score', title: 'Margin % × Chaos/h × Per 1k gold', sort: 'score', num: true, cell: (r) => r.score, cls: () => 'strong' },
  { label: 'Gold/flip', title: "Gold to buy one unit (its fee) and sell it for Divines (250 per Divine wanted)", sort: 'gold', num: true, cell: (r) => r.gold },
  { label: 'Per 1k gold', title: 'Margin per 1,000 gold spent on the two orders', sort: 'per_gold', num: true, cell: (r) => r.perGold },
  { label: 'Chaos/h', title: 'Chaos traded per covered hour in the slower of the two markets', sort: 'turnover', num: true, cell: (r) => r.turnover },
];

/** @returns {Column[]} */
function columns() {
  return state.quote === 'flip' ? FLIP_COLUMNS : marketColumns(state.quote);
}

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Creates an element; children are text or nodes, so API data is never parsed as HTML.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} children
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

let state = view.stateFromSearch(window.location.search);
/** @type {{ name: string, active: boolean, eligible_markets_24h: number }[]} */
let leagues = [];
let total = 0;
/** @type {AbortController | undefined} */
let marketsRequest;
/** @type {AbortController | undefined} */
let historyRequest;
/** @type {uPlot[]} */
let charts = [];
/** Rows of the current flip page by id, so the detail can show the flip's own figures. @type {Map<string, ReturnType<typeof view.flipRow>>} */
let flipRows = new Map();

/**
 * Updates the state and the address bar. Choices a user would go back from (league, market) add a history entry.
 * @param {Partial<view.State>} patch
 * @param {{ push?: boolean }} [options]
 */
function update(patch, { push = false } = {}) {
  state = { ...state, ...patch };
  const url = `${window.location.pathname}${view.searchFromState(state)}`;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

// ---- status ----------------------------------------------------------------------------------------------------------

async function loadStatus() {
  const box = $('status');
  const list = /** @type {HTMLUListElement} */ ($('problems'));
  try {
    const banner = view.statusBanner(await api('/api/status'));
    box.textContent = banner.text;
    box.dataset.level = banner.level;
    list.replaceChildren(...banner.problems.map((p) => el('li', {}, p)));
    list.hidden = banner.problems.length === 0;
  } catch (error) {
    box.textContent = 'Data status unavailable';
    box.dataset.level = 'down';
    list.replaceChildren(el('li', {}, error instanceof ApiError ? error.message : String(error)));
    list.hidden = false;
  }
}

// ---- leagues ---------------------------------------------------------------------------------------------------------

async function loadLeagues() {
  const select = /** @type {HTMLSelectElement} */ ($('league'));
  const body = await api('/api/leagues');
  leagues = body.data;
  select.replaceChildren(
    ...leagues.map((l) =>
      el('option', { value: l.name }, `${l.name}${l.active ? '' : ' (ended)'}`),
    ),
  );
  select.disabled = leagues.length === 0;
  if (!leagues.some((l) => l.name === state.league)) {
    update({ league: (leagues.find((l) => l.active) ?? leagues[0])?.name ?? '', offset: 0 });
  }
  select.value = state.league;
}

// ---- market table ----------------------------------------------------------------------------------------------------

/** One full-width message row in the table body. @param {string} kind @param {(Node | string)[]} content */
function tableMessage(kind, ...content) {
  $('rows').replaceChildren(el('tr', { class: `message ${kind}` }, el('td', { colspan: String(columns().length) }, ...content)));
}

async function loadMarkets() {
  marketsRequest?.abort();
  const request = new AbortController();
  marketsRequest = request;
  const table = $('table');
  table.setAttribute('aria-busy', 'true');
  syncControls();
  if (!state.league) {
    tableMessage(
      'empty',
      'No market metrics yet. Collect and compute them with ',
      el('code', {}, 'npm run fetch; npm run parse; npm run metrics'),
      '.',
    );
    renderPager();
    table.removeAttribute('aria-busy');
    return;
  }
  if (!$('rows').childElementCount) tableMessage('loading', 'Loading markets…');
  try {
    const quote = state.quote;
    if (quote === 'flip') {
      const body = await api('/api/flips', view.flipQuery(state, PAGE_SIZE), request.signal);
      total = body.meta.total;
      const rows = body.data.map((/** @type {view.FlipMarket} */ f) => view.flipRow(f));
      flipRows = new Map(rows.map((/** @type {ReturnType<typeof view.flipRow>} */ r) => [r.id, r]));
      renderRows(rows);
      const rate = body.meta.divine_rate === null ? 'no Chaos/Divine rate in this window' : `1 Divine valued at ${body.meta.divine_rate.toFixed(1)}c`;
      $('table-meta').textContent =
        `${state.window} window ending ${view.hourText(body.meta.as_of_hour)} · buy at the Chaos market's Low, sell at the ` +
        `Divine market's High · ${rate} (the window's Chaos/Divine rate) · ranked by Margin % × Chaos/h × Per 1k gold, ` +
        'among items eligible in both markets with a positive margin';
    } else {
      const body = await api('/api/markets', view.marketQuery(state, PAGE_SIZE), request.signal);
      total = body.meta.total;
      const unit = view.QUOTE_UNITS[quote];
      renderRows(body.data.map((/** @type {view.Market} */ m) => view.marketRow(m, quote)));
      $('table-meta').textContent =
        `${state.window} window ending ${view.hourText(body.meta.as_of_hour)} · calculation v${body.meta.calc_version} · ` +
        `ranked by score = (High − Low) / Low × ${unit.column} × Per 1k gold, among markets with ≥75% coverage, ` +
        `trades in ≥50% of hours and ≥${unit.minPerHour}`;
    }
  } catch (error) {
    if (isAbort(error)) return;
    total = 0;
    const retry = el('button', { type: 'button' }, 'Retry');
    retry.addEventListener('click', () => void loadMarkets());
    tableMessage('error', `Could not load markets: ${error instanceof ApiError ? error.message : String(error)} `, retry);
  } finally {
    if (marketsRequest === request) table.removeAttribute('aria-busy');
  }
  renderPager();
}

/** @param {{ id: string, eligible: boolean }[]} rows */
function renderRows(rows) {
  if (rows.length === 0) {
    /** @type {(Node | string)[]} */
    const content = [state.q ? `No markets match “${state.q}”.` : 'No markets in this window.'];
    if (state.scope === 'eligible') {
      const all = el('button', { type: 'button' }, 'Include ineligible markets');
      all.addEventListener('click', () => {
        update({ scope: 'all', offset: 0 });
        void loadMarkets();
      });
      content.push(' Few markets pass the ranking thresholds when data is incomplete. ', all);
    }
    tableMessage('empty', ...content);
    return;
  }
  const cols = columns();
  $('rows').replaceChildren(
    ...rows.map((r) =>
      el(
        'tr',
        { class: [r.id === state.market ? 'selected' : '', r.eligible ? '' : 'ineligible'].join(' ').trim() },
        ...cols.map((c) => el('td', { class: [c.num ? 'num' : '', c.cls?.(r) ?? ''].join(' ').trim() }, c.cell(r))),
      ),
    ),
  );
}

/** Rebuilds the header row for the current view, marking the sorted column. */
function renderHead() {
  const order = state.order || (state.sort === 'rank' || state.sort === 'name' ? 'asc' : 'desc');
  $('head').replaceChildren(
    ...columns().map((c) => {
      const attrs = /** @type {Record<string, string>} */ ({ class: c.num ? 'num' : '' });
      if (c.title) attrs.title = c.title;
      if (c.sort) {
        attrs['data-sort'] = c.sort;
        attrs.tabindex = '0';
        attrs['aria-sort'] = c.sort === state.sort ? (order === 'asc' ? 'ascending' : 'descending') : 'none';
      }
      return el('th', attrs, c.label);
    }),
  );
}

function renderPager() {
  const from = total === 0 ? 0 : state.offset + 1;
  const to = Math.min(total, state.offset + PAGE_SIZE);
  $('page-info').textContent = total === 0 ? '' : `${from}–${to} of ${total}`;
  /** @type {HTMLButtonElement} */ ($('prev')).disabled = state.offset === 0;
  /** @type {HTMLButtonElement} */ ($('next')).disabled = to >= total;
}

function syncControls() {
  const form = /** @type {HTMLFormElement} */ ($('controls'));
  for (const input of form.querySelectorAll('input[name="window"]')) {
    /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === state.window;
  }
  /** @type {HTMLInputElement} */ ($('scope')).checked = state.scope === 'all';
  for (const input of form.querySelectorAll('input[name="quote"]')) {
    /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === state.quote;
  }
  renderHead();
  const q = /** @type {HTMLInputElement} */ ($('q'));
  if (document.activeElement !== q) q.value = state.q;
  /** @type {HTMLSelectElement} */ ($('league')).value = state.league;
}

// ---- market detail ---------------------------------------------------------------------------------------------------

async function loadHistory() {
  const panel = $('detail');
  historyRequest?.abort();
  for (const c of charts) c.destroy();
  charts = [];
  if (!state.market || !state.league) {
    panel.hidden = true;
    return;
  }
  const request = new AbortController();
  historyRequest = request;
  panel.hidden = false;
  for (const input of panel.querySelectorAll('input[name="history"]')) {
    /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === state.history;
  }
  const body = $('detail-body');
  body.replaceChildren(el('p', { class: 'loading' }, 'Loading history…'));
  /** @param {view.Quote} quote */
  const fetchHistory = (quote) =>
    api(
      `/api/markets/${encodeURIComponent(state.market)}/history`,
      { league: state.league, quote, window: state.history },
      request.signal,
    );
  try {
    if (state.quote === 'flip') {
      const [buy, sell] = await Promise.all([fetchHistory('chaos'), fetchHistory('divine')]);
      $('detail-title').textContent = buy.data.item.name;
      const flip = flipRows.get(state.market);
      /** @type {(Node | string)[]} */
      const parts = [el('p', { class: 'path' }, `${buy.data.item.category} · `, el('code', {}, buy.data.item.path))];
      if (flip) {
        parts.push(
          statsList([
            ['Buy', flip.buy, "Lowest price in the Chaos market (table's window)"],
            ['Sell', flip.sell, "Highest price in the Divine market (table's window)"],
            ['Sell in c', flip.sellChaos, "At the window's Chaos/Divine rate"],
            ['Margin', flip.margin, 'Per unit; an upper bound'],
            ['Gold/flip', flip.gold, 'Buy order plus Divine sell order'],
            ['Per 1k gold', flip.perGold, 'Margin per 1,000 gold'],
          ]),
        );
      }
      const buySection = marketSection(buy, 'chaos', 'Buying: Chaos market');
      const sellSection = marketSection(sell, 'divine', 'Selling: Divine market');
      body.replaceChildren(...parts, buySection.node, sellSection.node, historyNote(buy));
      buySection.draw();
      sellSection.draw();
    } else {
      const history = await fetchHistory(state.quote);
      $('detail-title').textContent = history.data.item.name;
      const section = marketSection(history, state.quote, '');
      body.replaceChildren(
        el('p', { class: 'path' }, `${history.data.item.category} · `, el('code', {}, history.data.item.path)),
        section.node,
        historyNote(history),
      );
      section.draw();
    }
  } catch (error) {
    if (isAbort(error)) return;
    $('detail-title').textContent = 'Market';
    body.replaceChildren(
      el('p', { class: 'error' }, `Could not load history: ${error instanceof ApiError ? error.message : String(error)}`),
    );
  }
}

/** @param {[string, string, string][]} stats [label, value, hint] */
function statsList(stats) {
  return el('dl', { class: 'stats' }, ...stats.map(([term, value, hint]) => el('div', {}, el('dt', { title: hint }, term), el('dd', {}, value))));
}

/** @param {any} history */
function historyNote(history) {
  return el(
    'p',
    { class: 'meta' },
    `Hours up to ${view.hourText(history.meta.as_of_hour)}. Gaps in the lines are hours without trades; grey hours have no data. ` +
      'Prices are what past trades paid, not what you can trade at now.',
  );
}

/**
 * One market's summary, chart and hour strip. The chart is drawn by `draw` once the node is in the page, since
 * uPlot sizes itself from its container.
 * @param {any} history
 * @param {view.Quote} quote
 * @param {string} heading
 */
function marketSection(history, quote, heading) {
  const { item, summary } = history.data;
  const series = view.historySeries(history.data);
  const row = view.marketRow({ ...summary, id: history.data.id, item, rank: null, eligible: false }, quote);
  const unit = view.QUOTE_UNITS[quote];
  const chartBox = el('div', { class: 'chart', role: 'img', 'aria-label': `Hourly low and high price and ${unit.name} traded for ${item.name}` });
  const strip = el(
    'div',
    { class: 'strip', 'aria-hidden': 'true' },
    ...history.data.hours.map((/** @type {{ hour: string, status: string }} */ h) =>
      el('span', { class: `s-${h.status}`, title: `${view.hourText(h.hour)}: ${h.status}` }),
    ),
  );
  const legend = el(
    'ul',
    { class: 'legend' },
    ...view.statusCounts(series.statuses).map((s) => el('li', {}, el('span', { class: `swatch s-${s.status}` }), `${s.label}: ${s.count} h`)),
  );
  const node = el(
    'section',
    { class: 'market-section' },
    ...(heading ? [el('h3', {}, heading)] : []),
    statsList([
      ['Low', row.low, 'Lowest price paid in a trade during this window'],
      ['High', row.high, 'Highest price paid in a trade during this window'],
      ['High − Low', row.range, 'Highest minus lowest price paid; not a spread you can capture'],
      ['Score', row.score, `(High − Low) / Low × ${unit.column} × Per 1k gold`],
      ['Gold/flip', row.gold, 'Gold to buy one unit at Low and sell it at High'],
      ['Per 1k gold', row.perGold, 'What that flip earns per 1,000 gold; an upper bound'],
      [unit.column, row.turnover, `${unit.name} traded per hour with data`],
      ['Units/h', row.units, `${item.name} traded per hour with data`],
      ['Traded', row.traded, 'Hours with trades / hours with data'],
      ['Coverage', row.coverage, 'Hours with data / hours in the window'],
      ['Volatility', row.volatility, 'Spread of hourly rates, weighted by volume'],
    ]),
    chartBox,
    strip,
    legend,
  );
  const draw = () => {
    if (series.high.some((v) => v !== null)) charts.push(drawHistory(chartBox, series, quote));
    else chartBox.replaceChildren(el('p', { class: 'empty' }, 'No trades in this window.'));
  };
  return { node, draw };
}

// ---- events ----------------------------------------------------------------------------------------------------------

/** @type {number | undefined} */
let searchTimer;

function bindEvents() {
  $('league').addEventListener('change', (event) => {
    update({ league: /** @type {HTMLSelectElement} */ (event.target).value, offset: 0, market: '' }, { push: true });
    void loadMarkets();
    void loadHistory();
  });
  $('controls').addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.name === 'window') update({ window: /** @type {view.State['window']} */ (input.value), offset: 0 });
    else if (input.name === 'quote') {
      // A market id names the other item, which may not trade in the new view, so the detail closes. Sort keys differ
      // between the views, so sorting starts over.
      update({ quote: /** @type {view.State['quote']} */ (input.value), offset: 0, market: '', sort: 'rank', order: '' }, { push: true });
      void loadHistory();
    }
    else if (input.name === 'scope') update({ scope: input.checked ? 'all' : 'eligible', offset: 0 });
    else return;
    void loadMarkets();
  });
  $('controls').addEventListener('submit', (event) => event.preventDefault());
  $('q').addEventListener('input', (event) => {
    window.clearTimeout(searchTimer);
    const value = /** @type {HTMLInputElement} */ (event.target).value.trim();
    searchTimer = window.setTimeout(() => {
      update({ q: value, offset: 0 });
      void loadMarkets();
    }, 250);
  });
  // The header is rebuilt per view, so sorting listens on the header row.
  /** @param {Event} event */
  const sortBy = (event) => {
    const th = /** @type {HTMLElement} */ (event.target).closest('th[data-sort]');
    if (!th) return;
    const key = /** @type {view.State['sort']} */ (/** @type {HTMLElement} */ (th).dataset.sort);
    const current = state.order || (state.sort === 'rank' || state.sort === 'name' ? 'asc' : 'desc');
    update({ sort: key, order: key === state.sort ? (current === 'asc' ? 'desc' : 'asc') : '', offset: 0 });
    void loadMarkets();
  };
  $('head').addEventListener('click', sortBy);
  $('head').addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') sortBy(event);
  });
  $('prev').addEventListener('click', () => {
    update({ offset: Math.max(0, state.offset - PAGE_SIZE) });
    void loadMarkets();
  });
  $('next').addEventListener('click', () => {
    update({ offset: state.offset + PAGE_SIZE });
    void loadMarkets();
  });
  $('rows').addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button.item');
    if (!button) return;
    update({ market: /** @type {HTMLElement} */ (button).dataset.id ?? '' }, { push: true });
    for (const tr of $('rows').querySelectorAll('tr')) tr.classList.toggle('selected', tr.contains(button));
    void loadHistory();
  });
  $('detail').addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.name !== 'history') return;
    update({ history: /** @type {view.State['history']} */ (input.value) });
    void loadHistory();
  });
  $('close').addEventListener('click', () => {
    update({ market: '' }, { push: true });
    for (const tr of $('rows').querySelectorAll('tr.selected')) tr.classList.remove('selected');
    void loadHistory();
  });
  window.addEventListener('popstate', () => {
    state = view.stateFromSearch(window.location.search);
    void loadMarkets();
    void loadHistory();
  });
  window.addEventListener('resize', () => {
    for (const c of charts) c.setSize({ width: Math.max(280, c.root.parentElement?.clientWidth ?? 280), height: 260 });
  });
}

async function start() {
  bindEvents();
  syncControls();
  void loadStatus();
  try {
    await loadLeagues();
  } catch (error) {
    tableMessage('error', `Could not load leagues: ${error instanceof ApiError ? error.message : String(error)}`);
    return;
  }
  await Promise.all([loadMarkets(), loadHistory()]);
  // Keep the freshness banner honest while the page stays open.
  window.setInterval(() => void loadStatus(), 5 * 60 * 1000);
}

void start();
