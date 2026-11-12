import { type Draft, type FlipRow, heldWarning, type MarketRow } from './types.ts';

const NOT_RANKED = 'Not ranked on Flipping: too little coverage, trading or turnover in the window';

/**
 * A single-market flip: buy one unit at the window's lowest executed price and sell it at the highest, in the same
 * market. Eligible when the market is ranked on the Flipping page and the two prices differ. Null when the market had
 * no trades, or it is a Divine market and there is no Chaos/Divine rate.
 */
export function flipOpportunity(m: MarketRow, quote: 'chaos' | 'divine', chaosPerDivine: number | null): Draft | null {
  if (!m.low_rate || !m.high_rate || !(m.low_rate.value > 0)) return null;
  const toChaos = quote === 'chaos' ? 1 : chaosPerDivine;
  if (toChaos === null) return null;
  const cost = m.low_rate.value * toChaos;
  const value = m.high_rate.value * toChaos;
  const warnings = [heldWarning(m.held), m.eligible || m.held?.moving ? null : NOT_RANKED];
  // A ranked market whose lowest and highest prices were equal has nothing to flip.
  const flat = !(value > cost);
  if (flat) warnings.push('No price range in the window');
  if (m.gold_per_flip === null) warnings.push('Gold fee unknown');
  const quoteName = quote === 'chaos' ? 'Chaos' : 'Divine';
  return {
    id: `flip_${quote}:${m.id}`,
    kind: quote === 'chaos' ? 'flip_chaos' : 'flip_divine',
    title: m.item.name,
    item: m.item,
    legs: [
      { side: 'buy', label: m.item.name, item: m.item, quantity: 1, price: m.low_rate.value, quote },
      { side: 'sell', label: m.item.name, item: m.item, quantity: 1, price: m.high_rate.value, quote },
    ],
    cost_chaos: cost,
    return_chaos: value,
    profit_chaos: value - cost,
    margin_share: (value - cost) / cost,
    gold_per_cycle: m.gold_per_flip,
    chaos_per_1k_gold: m.quote_per_1k_gold === null ? null : m.quote_per_1k_gold * toChaos,
    cycles_per_hour: m.units_per_hour,
    basis: 'range',
    eligible: m.eligible && !flat,
    warnings: warnings.filter((w): w is string => w !== null),
    detail: { market_id: m.id, quote, quote_name: quoteName },
  };
}

/**
 * A Chaos → Divine trade: buy at the Chaos market's low, sell for Divines at the Divine market's high. The cycle rate
 * is the slower market's units per hour.
 */
export function tradeOpportunity(
  f: FlipRow,
  chaosMarket: MarketRow | undefined,
  divineMarket: MarketRow | undefined,
  chaosPerDivine: number,
): Draft | null {
  if (!f.buy || !f.sell || f.sell_chaos === null || f.margin_chaos === null || f.margin_share === null) return null;
  const units = [chaosMarket?.units_per_hour, divineMarket?.units_per_hour];
  const known = units.every((u) => u !== null && u !== undefined);
  const warnings = [heldWarning(f.held)];
  if (!f.eligible && !f.held?.moving) {
    warnings.push(f.margin_chaos <= 0 ? 'Selling for Divines pays less than buying for Chaos' : 'Not ranked: one of the two markets is too thin');
  }
  if (f.gold_per_flip === null) warnings.push('Gold fee unknown');
  return {
    id: `trade_c_d:${f.id}`,
    kind: 'trade_c_d',
    title: f.item.name,
    item: f.item,
    legs: [
      { side: 'buy', label: f.item.name, item: f.item, quantity: 1, price: f.buy.value, quote: 'chaos' },
      { side: 'sell', label: f.item.name, item: f.item, quantity: 1, price: f.sell.value, quote: 'divine' },
    ],
    cost_chaos: f.buy.value,
    return_chaos: f.sell_chaos,
    profit_chaos: f.margin_chaos,
    margin_share: f.margin_share,
    gold_per_cycle: f.gold_per_flip,
    chaos_per_1k_gold: f.chaos_per_1k_gold,
    cycles_per_hour: known ? Math.min(units[0]!, units[1]!) : null,
    basis: 'range',
    eligible: f.eligible,
    warnings: warnings.filter((w): w is string => w !== null),
    detail: { buy_market_id: f.id, sell_market_id: f.id, divine_rate: chaosPerDivine },
  };
}
