# Opportunities view

Status: proposed, 2026-11-12. Not yet implemented.

## Goal

The dashboard at `/` screens one kind of opportunity: flipping on the currency exchange (single-market low → high, and the Chaos → Divine cross flip). Players also want to see other ways to make currency from the same market data: cross-currency trades, crafting and conversion recipes, and Runegraft 3:1 conversions. Today Runegraft is a CLI report only (`npm run runegraft`).

This spec adds an **Opportunities** page: one list of every kind of opportunity, in the same units and with the same caveats, so a player can compare them and pick what to do next.

**Opportunities becomes the landing page (`/`). The existing dashboard moves to `/flipping`** under a "Flipping" tab. It keeps its query parameters, columns, ranking and detail panel. The only change to it is a shared top navigation bar linking the two pages. Old dashboard links keep working: a request to `/` that carries any dashboard parameter (`quote`, `scope`, `open`, `history`, …) redirects with 302 to `/flipping` with the same query string.

## Definitions

| Kind | Id | What the player does | Already computed by |
|---|---|---|---|
| Flip (Chaos) | `flip_chaos` | Buy X for Chaos at the window low, sell X for Chaos at the window high | `market_metrics` Chaos snapshot, `listMarkets` |
| Flip (Divine) | `flip_divine` | The same in X's Divine market | `market_metrics` Divine snapshot, `listMarkets` |
| Trade: Chaos → Divine | `trade_c_d` | Buy X for Chaos, sell X for Divines (C → X → D) | `listFlips`, `crossFlip` |
| Trade: Divine → Chaos | `trade_d_c` | Buy X for Divines, sell X for Chaos (D → X → C) | New, mirrors `crossFlip` (phase 2) |
| Runegraft 3:1 | `runegraft` | Buy 3 Runegrafts below the threshold, vendor them for a random Runegraft | `src/market/runegraft.ts` |
| Recipe / crafting | `recipe` | Buy the inputs of a known recipe on the exchange, craft or vendor, sell the output | **Not implemented yet.** Reserved kind, built in phase 3 |

"Flipping" means buying and selling the same item in one market. "Trading" means buying in one quote currency and selling in another. "Crafting" here means only recipes whose inputs and outputs are all exchange currency items with prices in our data. Gear crafting needs item prices we don't collect, so it's out of scope (see [Open questions](#open-questions)).

Crafting has no code today. Until phase 3 ships, the API doesn't accept `recipe` in `kinds` (400), and the page shows a disabled "Crafting · coming soon" chip, so the planned kind is visible without pretending to have data.

## User journey

1. Open the site: **Opportunities** is the landing page. It uses the league and window last used on Flipping, when they're passed in the URL.
2. See one table of opportunities of all kinds, best first.
3. Narrow the list by kind (chips: Flips, Trades, Runegraft, Recipes), search by item, or set a minimum profit.
4. Open a row to see how it was calculated: prices, legs, EV breakdown, history chart, warnings.
5. For a flip or trade, jump to the item's market on the Flipping page.

## Common opportunity record

Every kind is turned into one record. The API returns these; the page renders only these.

```ts
type OpportunityKind = 'flip_chaos' | 'flip_divine' | 'trade_c_d' | 'trade_d_c' | 'runegraft' | 'recipe';

interface Opportunity {
  id: string;                    // `${kind}:${encoded key}`, stable across refreshes
  kind: OpportunityKind;
  title: string;                 // "Divine Orb", "Runegraft of the Fortress ×3 → random Runegraft"
  item: ItemJson | null;         // main item, for search and the item cell
  /** What is bought and sold per cycle (one flip, one conversion, one craft). */
  legs: { side: 'buy' | 'sell' | 'expect'; item: ItemJson; quantity: number; price: RationalJson; quote: 'chaos' | 'divine' }[];
  /** All money values are Chaos per cycle; Divine legs are converted at the window's Chaos/Divine rate. */
  cost_chaos: number;
  return_chaos: number;          // sale value, or expected value for a random outcome
  profit_chaos: number;          // return − cost; may be negative under scope=all
  margin_share: number;          // profit / cost
  gold_per_cycle: number | null;
  chaos_per_1k_gold: number | null;
  /** Units of the thinnest leg traded per covered hour; null when unknown. */
  cycles_per_hour: number | null;
  /** profit_chaos × cycles_per_hour: an upper bound, not an expected income. */
  chaos_per_hour_ceiling: number | null;
  /** How far to trust the number. */
  basis: 'range' | 'ev' | 'ev_estimate';
  eligible: boolean;
  warnings: string[];            // "held 2/6, moving", "EV is an estimate: 3 outcomes unpriced", …
  detail: unknown;               // kind-specific payload for the detail panel, see below
}
```

`basis` tells the player what kind of number they're looking at:

- `range`: built from the window's lowest and highest executed prices (flips and trades). It's an upper bound, as on the dashboard today.
- `ev`: expected value from a complete probability table and complete prices.
- `ev_estimate`: EV with missing probabilities or prices (`EvResult.estimate`).

The page shows `basis` as a badge on each row.

## Ranking across kinds

Kind-specific scores can't be compared. The flip score multiplies the price range by turnover and by gold, and Runegraft has no score at all. So the Opportunities page ranks by one shared field:

> **chaos_per_hour_ceiling = profit_chaos × cycles_per_hour**

- Flips: `cycles_per_hour` = base units traded per covered hour (`base_per_hour`).
- Trades: units per hour of the slower of the two markets, as `crossFlip` already does for turnover.
- Runegraft / recipes: the input market's units per hour ÷ inputs per cycle. The output side isn't a limit, because outcomes are spread across many markets.

Every number is an upper bound. The page says so in the column header tooltip and in a notice like the dashboard's. Rows without a ceiling (unknown gold or volume) sort last. The user can also sort by profit per cycle, margin %, per 1k gold, and cycles/h.

Only **eligible** rows are listed by default:

- Flips and trades use the existing eligibility rules, including `held` / `moving`.
- Runegraft rows use `findOpportunities`: buy price strictly below `recommendedBuyPrice`, and the input market passes the same coverage and persistence thresholds.

With "Include ineligible", other rows are shown, unranked and with a reason in `warnings`.

This replaces neither the dashboard's score nor `#7`. When fill-time estimates land, `cycles_per_hour` becomes the estimated fill rate and the column is renamed from "ceiling" to "estimate".

## API

`GET /api/opportunities`

| Parameter | Values | Default |
|---|---|---|
| `league` | league name | required |
| `window` | `1`, `24` | `1` |
| `kinds` | comma list of kind ids | all implemented kinds |
| `scope` | `eligible`, `all` | `eligible` |
| `q` | search text (≤100 chars) | none |
| `min_profit` | Chaos per cycle | none |
| `sort` | `ceiling`, `profit`, `margin_pct`, `per_gold`, `cycles`, `name` | `ceiling` |
| `order` | `asc`, `desc` | `desc` (`asc` for `name`) |
| `limit`, `offset` | as `/api/markets` | 50, 0 |

The response has the same shape as the other lists: `{ data: Opportunity[], meta }`. `meta` carries:

- the usual snapshot freshness fields
- `divine_rate`
- `units`
- `counts` per kind (before pagination, so the chips can show "Runegraft (4)")
- `runegraft`: `{ ev, break_even, recommended, margin, estimate, warnings }`, the shared Runegraft numbers

The endpoint is cached like the other data routes: invalidated by `dataVersion`, keyed by sorted parameters.

### Server structure

```
src/opportunities/
  types.ts        Opportunity, OpportunityKind, provider interface
  flips.ts        flip_chaos / flip_divine from the market_metrics snapshots
  trades.ts       trade_c_d (reuses listFlips' query and crossFlip), trade_d_c later
  runegraft.ts    wraps runegraftPrices + expectedValue + findOpportunities
  recipes.ts      phase 3
  index.ts        listOpportunities: run the requested providers in parallel, merge, filter, sort, paginate
src/api/params.ts  parseOpportunityListParams
src/api/server.ts  route /api/opportunities
```

Each provider has the signature `(pool, { leagueId, window, scope }, context) => Promise<Opportunity[]>`. `context` holds the two snapshots and the Chaos/Divine rate, loaded once per request.

To feed `trades.ts`, refactor `listFlips` into a function that returns candidates plus a thin HTTP-shaping wrapper. `/api/flips` must return byte-identical responses before and after; the existing integration tests check this.

The Runegraft weights load once at server start through `loadWeights`. An invalid file fails startup, the same as the CLI. Settings that are CLI flags today (margin 30%, min outcome price 20c, no uniform assumption) become constants for the page in phase 1.

### Detail payloads

| Kind | `detail` | Panel shows |
|---|---|---|
| flip_* | `{ market_id, quote }` | The existing market history chart and stats, via `/api/markets/:id/history` |
| trade_* | `{ buy_market_id, sell_market_id, divine_rate }` | Both legs side by side, with a history chart per leg |
| runegraft | `{ inputs: 3, threshold, counted[], unknown_probability[], unpriced[] }` | The EV table (outcome, probability, price, contribution), threshold, and warnings |
| recipe | `{ recipe_id, inputs[], outputs[], source }` | The recipe, each leg's price, and the source link for the recipe |

## Page

- Routing in `serveStatic`:
  - `/` serves the new `public/opportunities.html`, unless the query has dashboard parameters (then the 302 above).
  - `/flipping` serves the current dashboard, renamed from `index.html` to `public/flipping.html`.
  - `public/opportunities.js` is new; `app.js` stays the dashboard's script. Its in-page links and `history.pushState` URLs use the `/flipping` path instead of `/`.
- `api.js`, `view.js` helpers, `chart.js` and `style.css` are reused. New pure formatting goes in `view.js` (`opportunityRow`, `basisBadge`), so `test/view.test.ts` covers it.
- Page state lives in the address bar like Flipping: `league`, `window`, `kinds`, `scope`, `q`, `min_profit`, `sort`, `order`, `page`, `open`. None of these names may collide with the dashboard parameters that trigger the redirect.
- Controls: league, window, kind chips (multi-select, with counts; Crafting disabled until phase 3), search, min profit, "Include ineligible", and a Chaos/Divine display toggle. The toggle changes display only; values stay Chaos in the API.
- Columns: Rank, Kind, Opportunity, Cost, Return, Profit, Margin %, Per 1k gold, Cycles/h, Chaos/h ceiling, Basis, Warnings (icon with tooltip).
- Notice text, as on Flipping: the numbers are upper bounds from past trades, not live quotes. EV rows are averages over many conversions, and a single conversion can lose.
- Navigation: a shared `<nav>` with "Opportunities" (`/`) and "Flipping" (`/flipping`) on both pages, keeping `league` and `window` when switching. Apart from the rename and the path, this is the only change to the dashboard.
- Mobile: the table scrolls horizontally inside `.table-wrap`, as on Flipping.

## Delivery phases

1. **Unified list with what exists.** `flip_chaos`, `flip_divine`, `trade_c_d`, `runegraft`; the API, the page, navigation, Opportunities at `/`, the dashboard at `/flipping` with the redirect for old links. The CLI `npm run runegraft` stays.
2. **More trades.** `trade_d_c` (D → X → C, audit §3.4), and direct Chaos/Divine direction checks (audit §3.5) where the data supports them. Both reuse the same two snapshots.
3. **Recipes / crafting (not implemented today).** Enables the `recipe` kind and the Crafting chip. A `data/recipes.json` describing deterministic or random recipes: inputs with quantities, outputs with quantities or probabilities, source, and verified date. Runegraft becomes one entry in it, with the weights file as its distribution. Each candidate recipe must be checked in-game, and its items confirmed on the exchange, before it's added. Candidates to check include fragment and splinter combinations and oil upgrades. A recipe with unverified data is shown as `ev_estimate` with a warning, never as `ev`.
4. **Later, blocked on data or on #7:** market making / order placement (`poe_market_making_audit.md`), multi-hop cycles, capital allocation across opportunities. These need order-book depth or fill-time estimates we don't have.

## Testing

- Unit: each provider's mapping into `Opportunity`, the ceiling formula, cross-kind sorting with nulls last, eligibility per kind, and `basis` selection (`ev` vs `ev_estimate`).
- Integration (`test/opportunities.integration.test.ts`): fixtures with Chaos and Divine snapshots and Runegraft markets. Cover filtering by `kinds`, `scope`, `q` and `min_profit`; pagination totals; `meta.counts`; cache invalidation on a new metrics run; and 400 on bad parameters.
- Regression: `/api/flips` and `/api/markets` responses unchanged. `test/dashboard.integration.test.ts` passes with only the page path changed from `/` to `/flipping`.
- Routing: `/` serves Opportunities; `/flipping` serves the dashboard; `/?quote=divine&open=…` redirects to `/flipping?quote=divine&open=…`; `kinds=recipe` returns 400 until phase 3.
- View: `opportunityRow` formatting, the state ↔ search round trip for the new parameters.

## Acceptance criteria

- `/` is the Opportunities page. It lists flips, Chaos → Divine trades and Runegraft conversions for the chosen league and window in one table, and shows Crafting as coming soon.
- `/flipping` renders the dashboard exactly as before, apart from the navigation bar. Old `/?quote=…` links land on it.
- Every row shows cost, return and profit per cycle in Chaos, its basis, and its warnings. Missing data shows as "—" with a reason, never as 0.
- The default order is Chaos/h ceiling, highest first. It's labelled an upper bound.
- Kind filters, search, minimum profit and "Include ineligible" work and survive a reload through the URL.
- Opening a row shows how its numbers were calculated.
- Runegraft numbers match `npm run runegraft` for the same league, window and settings.
- The data age is visible, as on Flipping.

## Open questions

1. Does "trading" mean cross-currency trades (C ↔ D) as defined here, or something else, such as bulk buying and reselling in smaller lots?
2. Which crafting recipes matter most once phase 3 starts? Should gear crafting (bench, essences, fossils) be considered later, given it needs item prices outside the currency exchange?
3. Should Runegraft margin and minimum outcome price be adjustable on the page, or stay fixed?
4. Should values also be shown in Divine per hour (the audits' objective), or is the display toggle enough?
