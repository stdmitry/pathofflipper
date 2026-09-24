// The dashboard: page state lives in the address bar, data comes from the read API, text from view.js.
import { api, ApiError, isAbort } from './api.js';
import { drawHistory } from './chart.js';
import * as view from './view.js';

const PAGE_SIZE = 50;
const COLUMNS = 9;

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
/** @type {uPlot | undefined} */
let chart;

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
  $('rows').replaceChildren(el('tr', { class: `message ${kind}` }, el('td', { colspan: String(COLUMNS) }, ...content)));
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
    const body = await api('/api/markets', view.marketQuery(state, PAGE_SIZE), request.signal);
    total = body.meta.total;
    renderRows(body.data.map(view.marketRow));
    $('table-meta').textContent =
      `${state.window} window ending ${view.hourText(body.meta.as_of_hour)} · calculation v${body.meta.calc_version} · ` +
      'ranked by Chaos traded per hour, among markets with ≥75% coverage, trades in ≥50% of hours and ≥100c/h';
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

/** @param {ReturnType<typeof view.marketRow>[]} rows */
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
  $('rows').replaceChildren(
    ...rows.map((r) => {
      const open = el('button', { type: 'button', class: 'item', 'data-id': r.id }, r.name);
      if (r.unnamed) open.title = 'No display name known; showing its internal id';
      const row = el(
        'tr',
        { class: [r.id === state.market ? 'selected' : '', r.eligible ? '' : 'ineligible'].join(' ').trim() },
        el('td', { class: 'num' }, r.rank),
        el('td', {}, open, el('span', { class: 'category' }, r.category)),
        el('td', { class: 'num strong' }, r.low),
        el('td', { class: 'num strong' }, r.high),
        el('td', { class: 'num' }, r.turnover),
        el('td', { class: 'num' }, r.units),
        el('td', { class: 'num' }, r.traded),
        el('td', { class: `num${r.lowCoverage ? ' warn' : ''}` }, r.coverage),
        el('td', { class: 'num' }, r.volatility),
      );
      return row;
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
  const q = /** @type {HTMLInputElement} */ ($('q'));
  if (document.activeElement !== q) q.value = state.q;
  /** @type {HTMLSelectElement} */ ($('league')).value = state.league;
  for (const th of document.querySelectorAll('th[data-sort]')) {
    const key = /** @type {HTMLElement} */ (th).dataset.sort;
    const order = state.order || (state.sort === 'rank' || state.sort === 'name' ? 'asc' : 'desc');
    th.setAttribute('aria-sort', key === state.sort ? (order === 'asc' ? 'ascending' : 'descending') : 'none');
  }
}

// ---- market detail ---------------------------------------------------------------------------------------------------

async function loadHistory() {
  const panel = $('detail');
  historyRequest?.abort();
  chart?.destroy();
  chart = undefined;
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
  try {
    const history = await api(
      `/api/markets/${encodeURIComponent(state.market)}/history`,
      { league: state.league, window: state.history },
      request.signal,
    );
    renderDetail(history);
  } catch (error) {
    if (isAbort(error)) return;
    $('detail-title').textContent = 'Market';
    body.replaceChildren(
      el('p', { class: 'error' }, `Could not load history: ${error instanceof ApiError ? error.message : String(error)}`),
    );
  }
}

/** @param {any} history */
function renderDetail(history) {
  const { item, summary } = history.data;
  $('detail-title').textContent = item.name;
  const series = view.historySeries(history.data);
  const row = view.marketRow({ ...summary, id: history.data.id, item, rank: null, eligible: false });

  /** @type {[string, string, string][]} */
  const stats = [
    ['Low', row.low, 'Lowest price paid in a trade during this window'],
    ['High', row.high, 'Highest price paid in a trade during this window'],
    ['Chaos/h', row.turnover, 'Chaos traded per hour with data'],
    ['Units/h', row.units, `${item.name} traded per hour with data`],
    ['Traded', row.traded, 'Hours with trades / hours with data'],
    ['Coverage', row.coverage, 'Hours with data / hours in the window'],
    ['Volatility', row.volatility, 'Spread of hourly rates, weighted by volume'],
  ];
  const chartBox = el('div', { class: 'chart', role: 'img', 'aria-label': `Hourly low and high price and Chaos traded for ${item.name}` });
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

  $('detail-body').replaceChildren(
    el('p', { class: 'path' }, `${item.category} · `, el('code', {}, item.path)),
    el('dl', { class: 'stats' }, ...stats.map(([term, value, hint]) => el('div', {}, el('dt', { title: hint }, term), el('dd', {}, value)))),
    chartBox,
    strip,
    legend,
    el(
      'p',
      { class: 'meta' },
      `Hours up to ${view.hourText(history.meta.as_of_hour)}. Gaps in the lines are hours without trades; grey hours have no data. ` +
        'Prices are what past trades paid, not what you can trade at now.',
    ),
  );
  if (series.high.some((v) => v !== null)) chart = drawHistory(chartBox, series);
  else chartBox.replaceChildren(el('p', { class: 'empty' }, 'No trades in this window.'));
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
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.setAttribute('tabindex', '0');
    const sortBy = () => {
      const key = /** @type {view.State['sort']} */ (/** @type {HTMLElement} */ (th).dataset.sort);
      const current = state.order || (state.sort === 'rank' || state.sort === 'name' ? 'asc' : 'desc');
      update({ sort: key, order: key === state.sort ? (current === 'asc' ? 'desc' : 'asc') : '', offset: 0 });
      void loadMarkets();
    };
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') sortBy();
    });
  }
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
    const box = /** @type {HTMLElement | null} */ (document.querySelector('.chart'));
    if (chart && box) chart.setSize({ width: Math.max(280, box.clientWidth), height: 260 });
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
