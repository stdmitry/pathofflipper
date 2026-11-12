// The Opportunities page: every kind of opportunity in one table. State lives in the address bar, data comes from
// /api/opportunities, text from view.js.
import { api, ApiError, isAbort } from './api.js';
import { $, el, historyNote, marketSection, statsList } from './dom.js';
import * as view from './view.js';

const PAGE_SIZE = 50;

/**
 * @typedef {ReturnType<typeof view.opportunityRow>} Row
 * @typedef {{ label: string, title: string, sort?: view.OppState['sort'], num?: boolean, cell: (r: Row) => Node | string, cls?: (r: Row) => string }} Column
 */

/** @type {Column[]} */
const COLUMNS = [
  { label: 'Rank', title: 'Position by Chaos/h ceiling among eligible opportunities of every kind', num: true, cell: (r) => r.rank },
  { label: 'Kind', title: 'Flip: buy and sell in one market. Trade: buy for Chaos, sell for Divines. Runegraft: vendor three for a random one', cell: (r) => el('span', { class: 'kind' }, r.kind) },
  { label: 'Opportunity', title: '', sort: 'name', cell: itemCell },
  { label: 'Cost', title: 'What one cycle costs to buy', num: true, cell: (r) => r.cost },
  { label: 'Return', title: 'What one cycle sells for, or its expected value', num: true, cell: (r) => r.ret },
  { label: 'Profit', title: 'Return − cost per cycle', sort: 'profit', num: true, cell: (r) => r.profit, cls: (r) => (r.loss ? 'warn' : 'strong') },
  { label: 'Margin %', title: 'Profit / cost', sort: 'margin_pct', num: true, cell: (r) => r.marginPct },
  { label: 'Per 1k gold', title: 'Profit per 1,000 gold spent on the orders of one cycle', sort: 'per_gold', num: true, cell: (r) => r.perGold },
  { label: 'Cycles/h', title: "Cycles per hour the thinnest leg's traded volume allows", sort: 'cycles', num: true, cell: (r) => r.cycles },
  { label: 'Ceiling/h', title: 'Profit × cycles per hour: an upper bound, not an expected income', sort: 'ceiling', num: true, cell: (r) => r.ceiling, cls: () => 'strong' },
  { label: 'Basis', title: 'Range: from past low and high prices. EV: expected value of a random outcome. EV est.: from incomplete data', cell: (r) => el('span', { class: `badge basis-${r.basisKind}`, title: r.basisTitle }, r.basis) },
  { label: '', title: 'Warnings', cell: (r) => (r.warningCount ? el('span', { class: 'warn-icon', title: r.warnings, 'aria-label': r.warnings }, `⚠ ${r.warningCount}`) : '') },
];

/** @param {Row} r */
function itemCell(r) {
  const open = el('button', { type: 'button', class: 'item', 'data-id': r.id }, r.name);
  if (r.unnamed) open.title = 'No display name known; showing its internal id';
  return el('span', {}, open, el('span', { class: 'category' }, r.category));
}

let state = view.oppStateFromSearch(window.location.search);
let total = 0;
/** @type {number | null} */
let divineRate = null;
/** Opportunities of the current page by id, for the detail panel. @type {Map<string, view.Opportunity>} */
let current = new Map();
/** @type {AbortController | undefined} */
let listRequest;
/** @type {AbortController | undefined} */
let detailRequest;
/** @type {uPlot[]} */
let charts = [];

/** @param {Partial<view.OppState>} patch @param {{ push?: boolean }} [options] */
function update(patch, { push = false } = {}) {
  state = { ...state, ...patch };
  const url = `${window.location.pathname}${view.searchFromOppState(state)}`;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  syncNav();
}

/** The Flipping tab keeps the league and window. */
function syncNav() {
  /** @type {HTMLAnchorElement} */ ($('nav-flipping')).href = `/flipping${view.navSearch(state)}`;
}

/** @param {unknown} error */
const message = (error) => (error instanceof ApiError ? error.message : String(error));

// ---- status and leagues ------------------------------------------------------------------------------------------------

async function loadStatus() {
  const box = $('status');
  const list = $('problems');
  try {
    const banner = view.statusBanner(await api('/api/status'));
    box.textContent = banner.text;
    box.dataset.level = banner.level;
    list.replaceChildren(...banner.problems.map((p) => el('li', {}, p)));
    list.hidden = banner.problems.length === 0;
  } catch (error) {
    box.textContent = 'Data status unavailable';
    box.dataset.level = 'down';
    list.replaceChildren(el('li', {}, message(error)));
    list.hidden = false;
  }
}

async function loadLeagues() {
  const select = /** @type {HTMLSelectElement} */ ($('league'));
  const leagues = /** @type {{ name: string, active: boolean }[]} */ ((await api('/api/leagues')).data);
  select.replaceChildren(...leagues.map((l) => el('option', { value: l.name }, `${l.name}${l.active ? '' : ' (ended)'}`)));
  select.disabled = leagues.length === 0;
  if (!leagues.some((l) => l.name === state.league)) {
    update({ league: (leagues.find((l) => l.active) ?? leagues[0])?.name ?? '', page: 0 });
  }
  select.value = state.league;
}

// ---- table ---------------------------------------------------------------------------------------------------------------

/** @param {string} kind @param {(Node | string)[]} content */
function tableMessage(kind, ...content) {
  $('rows').replaceChildren(el('tr', { class: `message ${kind}` }, el('td', { colspan: String(COLUMNS.length) }, ...content)));
}

async function loadList() {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  const table = $('table');
  table.setAttribute('aria-busy', 'true');
  syncControls();
  if (!state.league) {
    tableMessage('empty', 'No market metrics yet. Collect and compute them with ', el('code', {}, 'npm run fetch; npm run parse; npm run metrics'), '.');
    total = 0;
    renderPager();
    table.removeAttribute('aria-busy');
    return;
  }
  if (!$('rows').childElementCount) tableMessage('loading', 'Loading opportunities…');
  try {
    const body = await api('/api/opportunities', view.opportunityQuery(state, PAGE_SIZE), request.signal);
    total = body.meta.total;
    divineRate = body.meta.divine_rate;
    current = new Map(body.data.map((/** @type {view.Opportunity} */ o) => [o.id, o]));
    renderChips(body.meta.counts);
    renderRows(body.data.map((/** @type {view.Opportunity} */ o) => view.opportunityRow(o, state.unit, divineRate)));
    $('table-meta').textContent = tableMeta(body.meta);
  } catch (error) {
    if (isAbort(error)) return;
    total = 0;
    const retry = el('button', { type: 'button' }, 'Retry');
    retry.addEventListener('click', () => void loadList());
    tableMessage('error', `Could not load opportunities: ${message(error)} `, retry);
  } finally {
    if (listRequest === request) table.removeAttribute('aria-busy');
  }
  renderPager();
  void loadDetail();
}

/** @param {any} meta */
function tableMeta(meta) {
  const rate = meta.divine_rate === null ? 'no Chaos/Divine rate in this window' : `1 Divine valued at ${meta.divine_rate.toFixed(1)}c`;
  const rg = meta.runegraft;
  const runegraft =
    rg.ev === null
      ? 'Runegraft EV unknown'
      : `Runegraft EV ${rg.ev.toFixed(1)}c${rg.estimate ? ' (estimate)' : ''}, buy below ${rg.recommended.toFixed(1)}c (${Math.round(rg.margin * 100)}% under break-even)`;
  return (
    `${state.window} window ending ${view.hourText(meta.as_of_hour)} · ${rate} · ${runegraft} · ranked by Chaos/h ceiling = ` +
    'profit per cycle × cycles per hour, among eligible opportunities of every kind'
  );
}

/** @param {Record<string, number>} counts */
function renderChips(counts) {
  const chosen = view.selectedKinds(state.kinds);
  $('kinds').replaceChildren(
    el('legend', {}, 'Kinds'),
    ...view.KINDS.map(({ kind, chip }) => {
      const input = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', name: 'kind', value: kind }));
      input.checked = chosen.includes(kind);
      return el('label', { class: 'chip' }, input, ` ${chip} (${counts[kind] ?? 0})`);
    }),
    el('label', { class: 'chip', title: 'Crafting recipes are planned (phase 3) and not implemented yet' }, el('input', { type: 'checkbox', disabled: '' }), ' Crafting · coming soon'),
  );
}

/** @param {Row[]} rows */
function renderRows(rows) {
  if (rows.length === 0) {
    /** @type {(Node | string)[]} */
    const content = [state.q ? `No opportunities match “${state.q}”.` : 'No opportunities in this window.'];
    if (state.scope === 'eligible') {
      const all = el('button', { type: 'button' }, 'Include ineligible');
      all.addEventListener('click', () => {
        update({ scope: 'all', page: 0 });
        void loadList();
      });
      content.push(' Few opportunities pass the thresholds when data is incomplete. ', all);
    }
    tableMessage('empty', ...content);
    return;
  }
  $('rows').replaceChildren(
    ...rows.map((r) =>
      el(
        'tr',
        { class: [r.id === state.open ? 'selected' : '', r.eligible ? '' : 'ineligible'].join(' ').trim() },
        ...COLUMNS.map((c) => el('td', { class: [c.num ? 'num' : '', c.cls?.(r) ?? ''].join(' ').trim() }, c.cell(r))),
      ),
    ),
  );
}

function defaultOrder() {
  return state.sort === 'name' ? 'asc' : 'desc';
}

function renderHead() {
  const order = state.order || defaultOrder();
  $('head').replaceChildren(
    ...COLUMNS.map((c) => {
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
  const offset = state.page * PAGE_SIZE;
  const to = Math.min(total, offset + PAGE_SIZE);
  $('page-info').textContent = total === 0 ? '' : `${offset + 1}–${to} of ${total}`;
  /** @type {HTMLButtonElement} */ ($('prev')).disabled = state.page === 0;
  /** @type {HTMLButtonElement} */ ($('next')).disabled = to >= total;
}

function syncControls() {
  const form = /** @type {HTMLFormElement} */ ($('controls'));
  for (const name of ['window', 'unit']) {
    for (const input of form.querySelectorAll(`input[name="${name}"]`)) {
      const radio = /** @type {HTMLInputElement} */ (input);
      radio.checked = radio.value === state[/** @type {'window' | 'unit'} */ (name)];
    }
  }
  /** @type {HTMLInputElement} */ ($('scope')).checked = state.scope === 'all';
  const q = /** @type {HTMLInputElement} */ ($('q'));
  if (document.activeElement !== q) q.value = state.q;
  const min = /** @type {HTMLInputElement} */ ($('min-profit'));
  if (document.activeElement !== min) min.value = state.min_profit;
  /** @type {HTMLSelectElement} */ ($('league')).value = state.league;
  renderHead();
}

// ---- detail --------------------------------------------------------------------------------------------------------------

async function loadDetail() {
  const panel = $('detail');
  detailRequest?.abort();
  for (const c of charts) c.destroy();
  charts = [];
  if (!state.open) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const input of panel.querySelectorAll('input[name="chart"]')) {
    /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === state.chart;
  }
  const body = $('detail-body');
  const o = current.get(state.open);
  if (!o) {
    $('detail-title').textContent = 'Opportunity';
    body.replaceChildren(el('p', { class: 'empty' }, 'This opportunity is not on the current page or no longer qualifies. Pick one from the table.'));
    return;
  }
  const request = new AbortController();
  detailRequest = request;
  $('detail-title').textContent = o.title;
  const row = view.opportunityRow(o, state.unit, divineRate);
  /** @type {(Node | string)[]} */
  const parts = [
    el('p', { class: 'path' }, `${row.kind} · `, el('code', {}, o.item.path)),
    el('p', {}, row.category),
    statsList([
      ['Cost', row.cost, 'What one cycle costs to buy'],
      ['Return', row.ret, 'What one cycle sells for, or its expected value'],
      ['Profit', row.profit, 'Per cycle'],
      ['Margin %', row.marginPct, 'Profit / cost'],
      ['Gold/cycle', row.gold, 'Gold for the orders of one cycle'],
      ['Per 1k gold', row.perGold, 'Profit per 1,000 gold'],
      ['Cycles/h', row.cycles, "What the thinnest leg's traded volume allows"],
      ['Ceiling/h', row.ceiling, 'Profit × cycles per hour; an upper bound'],
      ['Basis', row.basis, row.basisTitle],
    ]),
  ];
  if (o.warnings.length) parts.push(el('ul', { class: 'warnings' }, ...o.warnings.map((w) => el('li', {}, w))));
  const href = view.flippingHref(o, state);
  if (href) parts.push(el('p', {}, el('a', { href }, 'Open on the Flipping page →')));
  if (o.kind === 'runegraft') parts.push(...runegraftParts(o));
  body.replaceChildren(...parts, el('p', { class: 'loading' }, 'Loading history…'));

  /** @param {string} id @param {view.Quote} quote */
  const fetchHistory = (id, quote) =>
    api(`/api/markets/${encodeURIComponent(id)}/history`, { league: state.league, quote, window: state.chart }, request.signal);
  try {
    /** @type {[any, view.Quote, string][]} */
    let sections;
    if (o.kind === 'trade_c_d') {
      const [buy, sell] = await Promise.all([fetchHistory(o.detail.buy_market_id, 'chaos'), fetchHistory(o.detail.sell_market_id, 'divine')]);
      sections = [
        [buy, 'chaos', 'Buying: Chaos market'],
        [sell, 'divine', 'Selling: Divine market'],
      ];
    } else if (o.detail.market_id) {
      const quote = /** @type {view.Quote} */ (o.kind === 'flip_divine' ? 'divine' : 'chaos');
      sections = [[await fetchHistory(o.detail.market_id, quote), quote, o.kind === 'runegraft' ? 'Buying: Chaos market' : '']];
    } else {
      sections = [];
    }
    const built = sections.map(([history, quote, heading]) => marketSection(history, quote, heading));
    body.replaceChildren(...parts, ...built.map((s) => s.node), ...(sections[0] ? [historyNote(sections[0][0])] : []));
    for (const s of built) {
      const chart = s.draw();
      if (chart) charts.push(chart);
    }
  } catch (error) {
    if (isAbort(error)) return;
    body.replaceChildren(...parts, el('p', { class: 'error' }, `Could not load history: ${message(error)}`));
  }
}

/** The EV breakdown of a Runegraft conversion. @param {view.Opportunity} o */
function runegraftParts(o) {
  const d = o.detail;
  const money = (/** @type {number} */ n) => view.moneyText(n, state.unit, divineRate);
  const rows = [...d.counted].sort((a, b) => b.contribution - a.contribution);
  /** @type {Node[]} */
  const parts = [
    el('h3', {}, 'Expected value of one conversion'),
    statsList([
      ['EV', money(d.ev), `Sum of probability × price over outcomes priced above ${d.min_outcome_price}c`],
      ['Break-even', money(d.break_even), 'EV / 3 per input'],
      ['Buy below', money(d.threshold), `Break-even less a ${Math.round(d.margin * 100)}% safety margin`],
    ]),
    el(
      'table',
      { class: 'ev' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Outcome'), el('th', { class: 'num' }, 'Chance'), el('th', { class: 'num' }, 'Price'), el('th', { class: 'num' }, 'Adds'))),
      el(
        'tbody',
        {},
        ...rows.map((/** @type {any} */ c) =>
          el(
            'tr',
            {},
            el('td', {}, c.name),
            el('td', { class: 'num' }, `${(c.probability * 100).toFixed(2)}%`),
            el('td', { class: 'num' }, money(c.price_chaos)),
            el('td', { class: 'num' }, money(c.contribution)),
          ),
        ),
      ),
    ),
  ];
  if (d.unknown_probability.length) parts.push(el('p', { class: 'meta' }, `Unknown probability, left out: ${d.unknown_probability.join(', ')}`));
  if (d.unpriced.length) parts.push(el('p', { class: 'meta' }, `No price in this window, left out: ${d.unpriced.join(', ')}`));
  return parts;
}

// ---- events --------------------------------------------------------------------------------------------------------------

/** @type {number | undefined} */
let typingTimer;

function bindEvents() {
  $('league').addEventListener('change', (event) => {
    update({ league: /** @type {HTMLSelectElement} */ (event.target).value, page: 0, open: '' }, { push: true });
    void loadList();
  });
  $('controls').addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.name === 'window') update({ window: /** @type {view.OppState['window']} */ (input.value), page: 0 });
    else if (input.name === 'unit') update({ unit: /** @type {view.Quote} */ (input.value) });
    else if (input.name === 'scope') update({ scope: input.checked ? 'all' : 'eligible', page: 0 });
    else if (input.name === 'kind') {
      const kinds = [...$('kinds').querySelectorAll('input[name="kind"]:checked')].map((i) => /** @type {HTMLInputElement} */ (i).value);
      // At least one kind stays chosen; all of them is the default, kept out of the address bar.
      if (kinds.length === 0) {
        input.checked = true;
        return;
      }
      update({ kinds: kinds.length === view.KINDS.length ? '' : kinds.join(','), page: 0 });
    } else return;
    void loadList();
  });
  $('controls').addEventListener('submit', (event) => event.preventDefault());
  /** @param {string} id @param {(value: string) => Partial<view.OppState> | null} patch */
  const typed = (id, patch) =>
    $(id).addEventListener('input', (event) => {
      window.clearTimeout(typingTimer);
      const value = /** @type {HTMLInputElement} */ (event.target).value.trim();
      typingTimer = window.setTimeout(() => {
        const next = patch(value);
        if (!next) return;
        update({ ...next, page: 0 });
        void loadList();
      }, 300);
    });
  typed('q', (value) => ({ q: value }));
  typed('min-profit', (value) => (value === '' || /^-?\d{1,9}(\.\d{1,6})?$/.test(value) ? { min_profit: value } : null));

  /** @param {Event} event */
  const sortBy = (event) => {
    const th = /** @type {HTMLElement} */ (event.target).closest('th[data-sort]');
    if (!th) return;
    const key = /** @type {view.OppState['sort']} */ (/** @type {HTMLElement} */ (th).dataset.sort);
    const currentOrder = state.order || defaultOrder();
    update({ sort: key, order: key === state.sort ? (currentOrder === 'asc' ? 'desc' : 'asc') : '', page: 0 });
    void loadList();
  };
  $('head').addEventListener('click', sortBy);
  $('head').addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') sortBy(event);
  });
  $('prev').addEventListener('click', () => {
    update({ page: Math.max(0, state.page - 1) });
    void loadList();
  });
  $('next').addEventListener('click', () => {
    update({ page: state.page + 1 });
    void loadList();
  });
  $('rows').addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button.item');
    if (!button) return;
    update({ open: /** @type {HTMLElement} */ (button).dataset.id ?? '' }, { push: true });
    for (const tr of $('rows').querySelectorAll('tr')) tr.classList.toggle('selected', tr.contains(button));
    void loadDetail();
  });
  $('detail').addEventListener('change', (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.name !== 'chart') return;
    update({ chart: /** @type {view.OppState['chart']} */ (input.value) });
    void loadDetail();
  });
  $('close').addEventListener('click', () => {
    update({ open: '' }, { push: true });
    for (const tr of $('rows').querySelectorAll('tr.selected')) tr.classList.remove('selected');
    void loadDetail();
  });
  window.addEventListener('popstate', () => {
    state = view.oppStateFromSearch(window.location.search);
    syncNav();
    void loadList();
  });
  window.addEventListener('resize', () => {
    for (const c of charts) c.setSize({ width: Math.max(280, c.root.parentElement?.clientWidth ?? 280), height: 260 });
  });
}

async function start() {
  bindEvents();
  syncNav();
  syncControls();
  void loadStatus();
  try {
    await loadLeagues();
  } catch (error) {
    tableMessage('error', `Could not load leagues: ${message(error)}`);
    return;
  }
  await loadList();
  window.setInterval(() => void loadStatus(), 5 * 60 * 1000);
}

void start();
