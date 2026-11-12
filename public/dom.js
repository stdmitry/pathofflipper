// DOM helpers shared by the two pages: element creation and the market history section of the detail panel.
import { drawHistory } from './chart.js';
import * as view from './view.js';

/** @param {string} id */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Creates an element; children are text or nodes, so API data is never parsed as HTML.
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} children
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

/** @param {[string, string, string][]} stats [label, value, hint] */
export function statsList(stats) {
  return el('dl', { class: 'stats' }, ...stats.map(([term, value, hint]) => el('div', {}, el('dt', { title: hint }, term), el('dd', {}, value))));
}

/** @param {any} history */
export function historyNote(history) {
  return el(
    'p',
    { class: 'meta' },
    `Hours up to ${view.hourText(history.meta.as_of_hour)}. Gaps in the lines are hours without trades; grey hours have no data. ` +
      'Prices are what past trades paid, not what you can trade at now.',
  );
}

/**
 * One market's summary, chart and hour strip. The chart is drawn by `draw` once the node is in the page, since
 * uPlot sizes itself from its container; `draw` returns the chart so the page can resize and destroy it.
 * @param {any} history
 * @param {view.Quote} quote
 * @param {string} heading
 * @returns {{ node: HTMLElement, draw: () => uPlot | null }}
 */
export function marketSection(history, quote, heading) {
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
    if (series.high.some((v) => v !== null)) return drawHistory(chartBox, series, quote);
    chartBox.replaceChildren(el('p', { class: 'empty' }, 'No trades in this window.'));
    return null;
  };
  return { node, draw };
}
