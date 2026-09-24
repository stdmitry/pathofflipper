import { type Rational, toNumber } from './semantics.ts';

/**
 * Cross-quote flip: buy an item in its Chaos market, then sell it in its Divine market. Prices follow the other
 * views: buy at the Chaos market's window low, sell at the Divine market's window high. Divines are valued in Chaos
 * at the window's volume-weighted Chaos/Divine rate. Both extremes can come from single odd trades, so the margin is
 * an upper bound, not an expected profit.
 */
export interface FlipInput {
  /** Lowest Chaos price paid for one unit in the window. */
  buyLow: Rational;
  /** Highest Divine price paid for one unit in the window. */
  sellHigh: Rational;
  /** Chaos per Divine, the Chaos/Divine market's volume-weighted rate in the same window. */
  chaosPerDivine: number;
  /** Chaos traded per covered hour in the item's Chaos market. */
  chaosTurnover: number;
  /** Divines traded per covered hour in the item's Divine market. */
  divineTurnover: number;
  /** Gold fee per unit wanted of the item and of Divine Orb; null when unknown. */
  itemFee: number | null;
  divineFee: number | null;
}

export interface Flip {
  buyChaos: number;
  sellDivine: number;
  /** The Divine sale valued in Chaos. */
  sellChaos: number;
  /** Chaos gained per unit: sellChaos − buyChaos. Negative when selling for Divines pays less. */
  marginChaos: number;
  /** marginChaos / buyChaos. */
  marginShare: number;
  /** Chaos per hour of the slower market, the Divine side converted to Chaos. */
  turnoverChaos: number;
  /** Gold per unit: buying wants 1 item (itemFee), selling wants sellDivine Divines (divineFee each). */
  goldPerFlip: number | null;
  chaosPerKgold: number | null;
  /** marginShare × turnoverChaos × chaosPerKgold, the same shape as the single-market score; negative for a loss. */
  score: number | null;
}

export function crossFlip(input: FlipInput): Flip {
  const buyChaos = toNumber(input.buyLow);
  const sellDivine = toNumber(input.sellHigh);
  const sellChaos = sellDivine * input.chaosPerDivine;
  const marginChaos = sellChaos - buyChaos;
  const marginShare = marginChaos / buyChaos;
  const turnoverChaos = Math.min(input.chaosTurnover, input.divineTurnover * input.chaosPerDivine);
  const goldPerFlip =
    input.itemFee === null || input.divineFee === null ? null : input.itemFee + input.divineFee * sellDivine;
  const chaosPerKgold = goldPerFlip === null || goldPerFlip <= 0 ? null : (marginChaos / goldPerFlip) * 1000;
  return {
    buyChaos,
    sellDivine,
    sellChaos,
    marginChaos,
    marginShare,
    turnoverChaos,
    goldPerFlip,
    chaosPerKgold,
    // Margin % and Chaos per 1k gold share the margin's sign, so their product is positive for a loss too; the sign is
    // put back so losses score below every gain.
    score: chaosPerKgold === null ? null : Math.sign(marginChaos) * Math.abs(marginShare * turnoverChaos * chaosPerKgold),
  };
}
