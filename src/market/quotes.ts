/**
 * Quote currencies the metrics and the dashboard cover. Each quote is screened separately: prices read as quote units
 * per unit of the other item, and turnover is in quote units, so the minimum turnover is set per quote.
 */
export const QUOTE_ITEMS = {
  chaos: { path: 'Metadata/Items/Currency/CurrencyRerollRare', minPerHour: 100 },
  // About the same value as 100 Chaos at the ~330 Chaos per Divine seen in 2026.
  divine: { path: 'Metadata/Items/Currency/CurrencyModValues', minPerHour: 0.3 },
} as const;

export type Quote = keyof typeof QUOTE_ITEMS;

export const QUOTE_NAMES = Object.keys(QUOTE_ITEMS) as Quote[];
