import type { itemJson } from '../api/queries.ts';

/**
 * Opportunities view (spec: specs/opportunities-view-spec.md). Every kind of opportunity is normalised into one
 * record, so flips, trades and conversions can be listed and compared in one table.
 */

/** Kinds served today, in display order. */
export const OPPORTUNITY_KINDS = ['flip_chaos', 'flip_divine', 'trade_c_d', 'runegraft'] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** Kinds the spec reserves for later phases; asking for one is refused rather than silently answered empty. */
export const PLANNED_KINDS = { trade_d_c: 'phase 2', recipe: 'phase 3 (crafting)' } as const;

export type ItemJson = ReturnType<typeof itemJson>;

export interface Leg {
  /** `expect` is a random outcome valued at its expected value. */
  side: 'buy' | 'sell' | 'expect';
  /** What the leg trades; `item` is null for an outcome that is not one item (a random Runegraft). */
  label: string;
  item: ItemJson | null;
  quantity: number;
  /** Quote units per unit of the item. */
  price: number;
  quote: 'chaos' | 'divine';
}

/**
 * How far to trust the numbers: `range` comes from the window's lowest and highest executed prices (an upper bound),
 * `ev` from a complete probability table and complete prices, `ev_estimate` from an incomplete one.
 */
export type Basis = 'range' | 'ev' | 'ev_estimate';

export interface Opportunity {
  /** `${kind}:${market id}`, stable across refreshes and rebuilds. */
  id: string;
  kind: OpportunityKind;
  title: string;
  item: ItemJson;
  legs: Leg[];
  /** Chaos per cycle (one flip, one trade, one conversion); Divine legs at the window's Chaos/Divine rate. */
  cost_chaos: number;
  return_chaos: number;
  profit_chaos: number;
  /** profit / cost. */
  margin_share: number;
  gold_per_cycle: number | null;
  chaos_per_1k_gold: number | null;
  /** Cycles per covered hour the thinnest leg's traded volume allows; null when unknown. */
  cycles_per_hour: number | null;
  /** profit_chaos × cycles_per_hour: an upper bound, not an expected income. */
  chaos_per_hour_ceiling: number | null;
  basis: Basis;
  eligible: boolean;
  /** Position by ceiling among eligible opportunities of every kind; null when not eligible. */
  rank: number | null;
  warnings: string[];
  detail: Record<string, unknown>;
}

/** The subset of an /api/markets row the providers read. */
export interface MarketRow {
  id: string;
  item: ItemJson;
  rank: number | null;
  eligible: boolean;
  gold_per_flip: number | null;
  quote_per_1k_gold: number | null;
  held: { hours: number; checked: number; lookback: number; drift: number | null; moving: boolean } | null;
  coverage: number;
  persistence: number;
  units_per_hour: number | null;
  low_rate: { value: number } | null;
  high_rate: { value: number } | null;
}

/** The subset of an /api/flips row the trade provider reads. */
export interface FlipRow {
  id: string;
  item: ItemJson;
  eligible: boolean;
  buy: { value: number } | null;
  sell: { value: number } | null;
  sell_chaos: number | null;
  margin_chaos: number | null;
  margin_share: number | null;
  gold_per_flip: number | null;
  chaos_per_1k_gold: number | null;
  held: MarketRow['held'];
}

/** The fields every provider fills; rank and the ceiling are added when the list is assembled. */
export type Draft = Omit<Opportunity, 'rank' | 'chaos_per_hour_ceiling'>;

export function finish(draft: Draft): Opportunity {
  const ceiling = draft.cycles_per_hour === null ? null : draft.profit_chaos * draft.cycles_per_hour;
  return { ...draft, chaos_per_hour_ceiling: ceiling, rank: null };
}

export function heldWarning(held: MarketRow['held']): string | null {
  return held?.moving ? `Price moving: ${held.hours} of ${held.lookback} previous hours held the margin` : null;
}
