// The market history chart, drawn with the vendored uPlot (global `uPlot`, loaded before this module).
import { compact, hourText } from './view.js';

/** @param {string} name */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Draws each hour's lowest and highest traded price (lines with the band between them) and Chaos turnover (bars).
 * Hours without trades are null, so the lines break at gaps instead of interpolating across them.
 * @param {HTMLElement} container
 * @param {ReturnType<typeof import('./view.js').historySeries>} series
 * @returns {uPlot}
 */
export function drawHistory(container, series) {
  container.textContent = '';
  const accent = cssVar('--accent');
  const band = cssVar('--band');
  const bars = cssVar('--bars');
  const text = cssVar('--muted');
  const grid = cssVar('--grid');
  /** @type {(u: uPlot, v: number | null) => string} */
  const rateValue = (_u, v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}c`);
  const axis = { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };

  /** @type {uPlot.Options} */
  const options = {
    width: Math.max(280, container.clientWidth),
    height: 260,
    cursor: { points: { size: 6 } },
    scales: {
      x: { time: true },
      rate: { auto: true },
      turnover: { auto: true, range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
    },
    series: [
      { value: (_u, v) => (v === null ? '—' : hourText(new Date(v * 1000).toISOString())) },
      { label: 'Low', scale: 'rate', stroke: accent, width: 1.5, value: rateValue },
      { label: 'High', scale: 'rate', stroke: accent, width: 1.5, dash: [4, 3], value: rateValue },
      {
        label: 'Chaos traded',
        scale: 'turnover',
        stroke: bars,
        fill: bars,
        width: 0,
        points: { show: false },
        paths: uPlot.paths.bars?.({ size: [0.7, 24] }),
        value: (_u, v) => (v === null ? '—' : `${compact(v)}c`),
      },
    ],
    bands: [{ series: [2, 1], fill: band }],
    axes: [
      { ...axis },
      { ...axis, scale: 'rate', values: (_u, ticks) => ticks.map((t) => `${Number(t.toPrecision(3))}c`), size: 60 },
      { ...axis, scale: 'turnover', side: 1, grid: { show: false }, values: (_u, ticks) => ticks.map((t) => compact(t)), size: 56 },
    ],
  };
  const data = /** @type {uPlot.AlignedData} */ ([series.x, series.low, series.high, series.turnover]);
  return new uPlot(options, data, container);
}
