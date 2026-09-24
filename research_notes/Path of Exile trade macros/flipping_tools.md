# Currency Flipping and Bulk Trading Tools in Path of Exile 1 (2024-2026)

Research scope: tools, macros and data sources used for currency flipping and bulk trading on the PoE 1 PC realm, how the 3.25 Currency Exchange (Faustus) changed the workflow, and where a data-driven flipping tool built on Currency Exchange history could add value. Research date: 2026-09-23. About 20 searches and fetches. Reddit threads and YouTube videos could not be fetched directly, so the community workflow findings are thinner than planned (see Gaps).

## Which tools support bulk/currency trading workflows?

### Takeaway
The PoE 1 flipping toolset is split up. Whisper managers (MercuryTrade Community Fork, POE-Trades-Companion) handle player-to-player trade logistics. Net-worth trackers (Exilence CE) and bulk-sale sites (Wealthy Exile, PoExchange) handle valuation and liquidation. Price sites (poe.ninja, poe.watch, PoeStash) show current rates and some history. Very few tools are built for flipping itself, and those that exist are small hobby projects or broken legacy tools.

### Cited Findings
**Whisper managers / trade companions (player-to-player trades, still used for bulk trades outside the Exchange)**
- MercuryTrade Community Fork (Morph21) is a maintained fork of the original Exslims/MercuryTrade Java overlay for "tracking, trading, chat". Features: trade whisper notifications, a trade history for re-contacting buyers after a client crash, highlighting the stash location of the requested item, F5 to repeat the last trade whisper, and an "Overseer" buff/flask tracker — [GitHub Morph21/MercuryTrade-Community-Fork](https://github.com/Morph21/MercuryTrade-Community-Fork); [original Exslims/MercuryTrade](https://github.com/Exslims/MercuryTrade); [Issue #61 (F5 whisper)](https://github.com/Morph21/MercuryTrade-Community-Fork/issues/61)
- POE-Trades-Companion (lemasato, now under lemasatodev) is an AutoHotkey overlay that tracks incoming trade whispers and has an item-grid overlay for finding requested items. The latest stable release is reported as 1.16.2, plus a 1.17 beta (the search snippet did not give the year) — [GitHub lemasatodev/POE-Trades-Companion](https://github.com/lemasatodev/POE-Trades-Companion); [Releases](https://github.com/lemasatodev/POE-Trades-Companion/releases)
- PoE-Overlay Community Fork also has a trade companion module — [Issue #238 "Trade Companion improvements"](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork/issues/238)

**Net worth / stash trackers**
- Exilence CE is the community successor to Exilence Next. Viktor Gullmark stopped maintaining Exilence Next in September 2022. Exilence CE combines the official PoE API with poe.ninja prices to value the character, inventory and stash tabs in chaos/divine, with history over time and hourly-earnings breakdowns. It supports group net worth. Reported latest stable is v1.2.11 (Feb 2025), for Windows, macOS and Linux, licensed CC BY-NC 3.0 — [GitHub exilence-ce/exilence-ce](https://github.com/exilence-ce/exilence-ce); [PoeHow addon page](https://poe.how/addons/exilence-ce); [TheGamerCodex](https://thegamercodex.com/en/path-of-exile/tools/exilence-ce)
- The original Exilence is DEPRECATED (historical) — [GitHub viktorgullmark/exilence](https://github.com/viktorgullmark/exilence)
- PoeStash advertises itself as a "PoE Wealth Tracker" with currency and economy prices (Divine, Chaos, Exalted, divine-to-chaos rate), and its prices come from poe.ninja — [PoeStash](https://www.poestash.com/poe1/economy)

**Bulk selling**
- Wealthy Exile is a bulk-selling website with automated item pricing. YouTube promotions call it a "Bulk Selling Tool / Trade Stash Tabs" alternative to TFT (the Discord bulk-trade community) for 3.24. The site also advertises boss carry services — [wealthyexile.com](https://wealthyexile.com/); [YouTube: "Bulk Selling Tool / Better Than TFT ... 3.24"](https://www.youtube.com/watch?v=Phe1qLMRCUY); [YouTube: "NEW!! Bulk Selling Tool / Trade Stash Tabs"](https://www.youtube.com/watch?v=YAJtY1_NcvI); [ipaddress.com site summary](https://www.ipaddress.com/website/wealthyexile.com/)
- Maxroll's PoE 1 Currency Exchange guide recommends PoExchange for bulk-selling items the Exchange doesn't handle — [Maxroll PoE1 Currency Exchange Market](https://maxroll.gg/poe/currency/currency-exchange-market)

**Price and market data sites**
- poe.ninja has live PoE 1 currency overviews and historical graphs — [poe.ninja](https://poe.ninja/); [PoE1 Standard currency page](https://poe.ninja/poe1/economy/standard/currency)
- poe.watch has a "Currency Exchange" page with pair rates and ratios, and an API with historical price data (I could not render the page to check details) — [poe.watch/exchange](https://poe.watch/exchange); [poe.watch API docs](https://docs.poe.watch/)
- PoeHow (poe.how) runs an addon directory that lists tools such as Exilence CE — [poe.how addons](https://poe.how/addons/exilence-ce)

**Flipping-specific tools**
- tirendus/poe-flipper (PoE 1 only) is a Python Windows tray app. With the in-game Market Ratio panel open, Alt+Q screenshots it and reads it with offline OCR (RapidOCR). It then suggests 2-3 "clean, divisible" ratios in three tiers: Fast (about 3% undercut), Fair (match the best price) and Greedy (the highest margin between competing offers). It can auto-fill quantity fields and has a flip-budget mode that projects buy-then-resell profit. It has 0 stars and 0 forks, so almost nobody uses it — [GitHub tirendus/poe-flipper](https://github.com/tirendus/poe-flipper)
- Historical: maximumstock/poe-currency-flip-planner was a CLI arbitrage finder that used poe.trade and pathofexile.com/trade bulk data. It is described as non-working since poe.trade shut down — [GitHub maximumstock/poe-currency-flip-planner](https://github.com/maximumstock/poe-currency-flip-planner)
- Historical: ludwigbacklund/poeflipper is a Next.js "tool for flipping currency" with 9 commits. Its README did not describe how it works — [GitHub ludwigbacklund/poeflipper](https://github.com/ludwigbacklund/poeflipper)
- Historical/grey-area: the "PoE Currency Flipping Assistant" was released on the OwnedCore bot/programs forum — [OwnedCore thread](https://www.ownedcore.com/forums/mmo/path-of-exile/poe-bots-programs/651193-poe-currency-flipping-assistant.html)
- Grey-area/ToS risk: FrozenTear7/poe-trading-bot automatically places buy and sell orders from a configured setup. It describes itself as slower than a human but able to run autonomously — [GitHub FrozenTear7/poe-trading-bot](https://github.com/FrozenTear7/poe-trading-bot)

### Inferences
- Trade companions matter less for currency flipping since 3.25 because currency no longer needs whispers. They still matter for non-stackable bulk (maps, gems, uniques). A flipping tool doesn't need to compete with them.
- Every existing PoE 1 Exchange-specific tool I found works at the level of a single screen: poe-flipper reads the one panel currently shown and prices it. None tracks history, spreads over time, or a portfolio of flips.

### Gaps
- I found no reliable sources on Discord bots made for PoE 1 currency flipping (for example, price-alert bots). TFT is a known bulk-trade Discord, but I found no primary source on its tooling beyond the Wealthy Exile comparison.
- I did not verify current maintenance status or last release dates for MercuryTrade Community Fork and POE-Trades-Companion.
- I did not verify Wealthy Exile's exact 2025-2026 features (for example, whether it uses Currency Exchange data), because the site content was not retrieved in detail.

## How did flipping change after the 3.25 Currency Exchange (Faustus), and what tools analyze Exchange data?

### Takeaway
Settlers of Kalguur (3.25) added an asynchronous, gold-fee order book at Faustus. Currency flipping moved from whispering people to placing and managing orders. GGG publishes only hourly aggregates of Exchange trades (high/low ratio, stock and volume per pair), with no live order book. Most analysis tools are therefore price-reference sites (poe.ninja, poe.watch). Tools that do margin or arbitrage analysis on this data exist mainly for PoE 2, not PoE 1.

### Cited Findings
**Exchange mechanics relevant to flipping**
- Faustus is in Kingsmarch and can be invited to the hideout. The Exchange lets players swap currency with other players without individual trades — [MMOGAH 3.25 Currency Exchange guide](https://www.mmogah.com/news/poe/poe-325-the-currency-exchange-market-guide); [Maxroll PoE1](https://maxroll.gg/poe/currency/currency-exchange-market)
- You can list up to 10 exchanges at a time. Orders can be partially filled and cancelled at any time. Listings cost gold, which rises in proportion to the amount traded. Hovering over the Market Ratio shows several of the best ratios currently listed. The Exchange accepts any tradable, stackable item — [Maxroll PoE1](https://maxroll.gg/poe/currency/currency-exchange-market)
- The Alt-hover over the market ratio shows competing orders with stock counts (documented for the PoE 2 version of the same system) — [Maxroll PoE2 flipping guide](https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange)
- An exploitable limit: a buy order can request at most 999,999, and ratios are capped. Rogue's Markers vs Divine Orbs could only be listed at about 65,000:1, which is worse than the real market rate. Flippers used this to profit from players who bought Markers directly with Divines. The advice was to convert Divine to Chaos and then buy Markers — [search summary of zleague.gg article on sirgog's post](https://www.zleague.gg/theportal/sirgog-how-flippers-exploit-the-currency-exchange-limitation-in-path-of-exile-settlers/) (the article URL now returns 404, so this is a secondary summary only)
- There is community pushback defending the Exchange: the forum thread "Currency trade via Faustus MUST stay in the game" — [PoE forum thread 3556861](https://www.pathofexile.com/forum/view-thread/3556861)
- Video guide: "Making Profit With The Currency Exchange - Path of Exile 3.25" — [YouTube](https://www.youtube.com/watch?v=TnuriWzyaeM) (not transcribed)

**Official data: GGG Currency Exchange API**
- The endpoint returns "aggregate Currency Exchange trade history across all leagues grouped into hourly digests". It serves the realms `pc` (default), `xbox`, `sony` and `poe2`. Each market entry has league, currency pair, `volume_traded` per currency, `lowest_stock`/`highest_stock` and `lowest_ratio`/`highest_ratio`. Paging uses `next_change_id` (a Unix timestamp truncated to the hour). There is a 5-minute delay, the current hour is not available, and old history "may be removed without notice" — [GGG developer docs reference](https://www.pathofexile.com/developer/docs/reference)
- The public host is reported as `https://web.poecdn.com/api/currency-exchange/<realm>/<id>`, where no OAuth is needed — [search summary citing poe.ninja docs](https://poe.ninja/docs/api); [poe2-faustus-arb README](https://github.com/Faizak9x/poe2-faustus-arb)

**Third-party analysis of Exchange data**
- poe.ninja exposes `GET /poe1/api/economy/exchange/current/overview?league=&type=` (13 PoE 1 types). It returns the primary value, volume (in primary currency and against the highest-volume pair), rates to the reference currency, and sparkline trend samples. There is **no historical data in the API**, only current values plus sparklines. PoE 1 overviews refresh about every 15 minutes and responses are HTTP-cached for about 5 minutes. The API exists to run the website and has no SLA — [poe.ninja API docs](https://poe.ninja/docs/api)
- poe.ninja notes that Exchange data comes from GGG in hourly chunks, so prices can lag by up to an hour — [search summary of poe.ninja](https://poe.ninja/docs/api)
- poe2-faustus-arb (PoE 2 only) pulls the hourly public Exchange API and models currencies as a graph, with edge weight = -log(rate). It uses Bellman-Ford to find triangular and multi-leg arbitrage cycles above 2% profit, which is configurable. Its design choices: it keeps only pairs above a self-scaling volume floor (default: the top 10% of traded pairs), assumes the worst-case rate within each hour's range as a stand-in for the bid-ask spread, and alerts only on cycles that last at least 2 consecutive hours. It never places trades — [GitHub Faizak9x/poe2-faustus-arb](https://github.com/Faizak9x/poe2-faustus-arb)
- Wrapper libraries exist, for example @klayver/poe-api-wrappers for official and third-party PoE APIs — [npm](https://www.npmjs.com/package/@klayver/poe-api-wrappers)
- PoE 2 has calculators such as poe2fun's "Alva" currency flipping calculator — [poe2fun](https://poe2fun.com/currency/calculator)

### Inferences
- The hourly `lowest_ratio`/`highest_ratio` range is a rough stand-in for the spread. A tool can show how wide the spread is and how it changes over time, which no PoE 1 site appears to offer. poe.ninja collapses each pair to one reference price.
- poe.ninja's API has no history, and GGG may delete old digests. A tool that stores the full hourly history (like this project's PostgreSQL ingestion) therefore has a data asset nobody else exposes publicly for PoE 1.
- The arbitrage-cycle approach in poe2-faustus-arb carries straight over to the PoE 1 `pc` realm. I found no PoE 1 equivalent.

### Gaps
- I did not find the date GGG first published the Currency Exchange API, or when poe.ninja switched PoE 1 currency pages to Exchange data.
- I found no primary source on the exact PoE 1 gold-fee formula.
- I could not fetch the poe.watch Exchange page, so I could not confirm whether it shows history or spreads per pair.

## What do experienced flippers report as their workflow, pain points, and margins?

### Takeaway
Flipping is described as three strategies: sniping, arbitrage and swing trading. The loop is: find a spread in the Market Ratio or order book, test volume, list both sides, and wait for fills. The main pain points are capital and gold requirements, slow fills, manipulation and volatility, and no price history inside the game. Most detailed margin figures come from PoE 2 guides. Reliable PoE 1-specific margin figures were not found.

### Cited Findings
- There are three forms of flipping: trade sniping, arbitrage and swing trading. One tactic is to ignore small orders and undercut or outbid only the blocking orders. This lowers turnover but raises margin. Good arbitrage candidates are stackable, Exchange-listable commodities that at least a few wealthy players want in very large quantities — [Mobalytics PoE 2 flipping guide](https://mobalytics.gg/poe-2/guides/currency-flipping) (PoE 2, same Exchange design)
- Maxroll workflow (PoE 2): find profitable ratios, test market volume, then list. Multi-exchange flipping goes through intermediate currencies. A hybrid approach buys via direct trade to avoid the fee and sells on the Exchange. Basic flipping reportedly returns about 0.75-1.2 per Exalted Orb invested, and multi-leg routes "almost double the profit". Pain points: high capital needs, fills taking hours to days, a thin Divine market, and volatility from meta and patch changes — [Maxroll PoE2 flipping guide](https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange)
- PoE 2 players report Divine:Exalt swings (about 110-120 up to over 200 ex/div), intraday cheap windows ("120-130 ex at certain times of day"), and warnings that a small market is prone to manipulation — [Steam PoE 2 discussion](https://steamcommunity.com/app/2694490/discussions/0/598516531140273041)
- On the PoE forum, players ask for in-game Exchange price-history graphs "like PoE2Scout and EVE Online". They also ask for filtering to completed trades rather than listings, and raise concerns about manipulation and about depending on third-party tools (Sept 2025, PoE 2 feedback forum) — [PoE forum thread 3855860](https://www.pathofexile.com/forum/view-thread/3855860)
- Older blog perspective on flipping bulk trade (pre-Exchange, 2023) — [Tales of the Aggronaut, "Flipping the Trade"](https://aggronaut.com/2023/09/20/flipping-the-trade/)
- The poe-flipper tool exists because players must work out clean, divisible ratios and competing prices by hand from the Market Ratio panel — [GitHub tirendus/poe-flipper](https://github.com/tirendus/poe-flipper)

### Inferences
- Common PoE 1 flip targets implied by sources: Chaos↔Divine, and bulk league currencies and fragments (Rogue's Markers are a documented example). I could not confirm a sourced PoE 1 list of the "most flipped" items.
- Timing matters (the "certain times of day" windows), so hour-of-day and day-of-week patterns in the hourly history would be directly useful.

### Gaps
- I could not access Reddit (r/pathofexile) flipping threads, and YouTube video content was not transcribed. I have no first-hand PoE 1 3.25+ figures for margins (for example, percent per flip or divines per hour).
- I found no sourced data on how many PoE 1 players flip, or on profit distributions.

## What features are missing that a flipping analytics tool could provide?

### Takeaway
No PoE 1 tool I found combines stored Exchange history with spread, volume and liquidity analytics. The biggest openings are spread and margin history per pair, liquidity-aware opportunity ranking, arbitrage-cycle detection for PoE 1, timing patterns, and manipulation flags. These are features that poe.ninja (no API history, a single reference price) and poe-flipper (single-screen OCR) do not cover.

### Cited Findings (evidence of the gaps)
- poe.ninja's API gives only current values and sparklines, with no history, and blends each pair into one reference price — [poe.ninja API docs](https://poe.ninja/docs/api)
- GGG's API gives high/low ratio and stock per pair per hour, but old data can be removed. Anyone who doesn't archive it loses it — [GGG developer docs](https://www.pathofexile.com/developer/docs/reference)
- The only PoE 1 Exchange-specific helper is an OCR ratio suggester with no history or analytics and 0 stars — [tirendus/poe-flipper](https://github.com/tirendus/poe-flipper)
- Multi-leg arbitrage detection with volume floors and persistence filters exists only for PoE 2 — [poe2-faustus-arb](https://github.com/Faizak9x/poe2-faustus-arb)
- Players explicitly ask for price-history graphs based on completed trades, and worry about manipulation — [PoE forum 3855860](https://www.pathofexile.com/forum/view-thread/3855860)
- Ratio and quantity caps cause mispricing, as in the Rogue's Marker 65,000:1 case — [zleague summary](https://www.zleague.gg/theportal/sirgog-how-flippers-exploit-the-currency-exchange-limitation-in-path-of-exile-settlers/)
- Capital, fill time and thin markets are the main flipper pain points — [Maxroll PoE2](https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange)

### Inferences (candidate features, each derived from the gaps above)
1. **Spread history per pair**: charts of `lowest_ratio` vs `highest_ratio` over time, with the spread as a percentage, ranked by pairs that are consistently wide.
2. **Liquidity-adjusted opportunity ranking**: combine spread with `volume_traded` and stock to estimate realistic throughput per hour. This addresses the "fills take hours to days" pain.
3. **PoE 1 arbitrage-cycle detector**: port the Bellman-Ford approach with volume floors and multi-hour persistence to the `pc` realm.
4. **Routing and conversion advice**: flag pairs where a direct pair is worse than going through Chaos or Divine, as in the Rogue's Marker case. This helps both flippers and ordinary players.
5. **Timing patterns**: hour-of-day and day-of-week seasonality per pair, and league-age curves using past leagues. This relies on archived history that GGG may delete.
6. **Anomaly and manipulation alerts**: sudden ratio or volume jumps against a rolling baseline, to catch cornering or price fixing.
7. **Profit after fees**: model gold cost and capital lock-up (10-listing limit, capital per flip). The exact PoE 1 gold formula still needs to be sourced.
8. **Order-sizing helper**: a web version of poe-flipper's divisible-ratio suggestions, fed by historical fair value rather than OCR.
9. **Portfolio and flip journal**: track realized P&L per flip. Exilence CE tracks net worth but not per-trade flipping P&L.

### Gaps
- None of these features is validated with real flippers. User interviews or Reddit surveys are needed.
- Hourly aggregates cannot show live order-book depth. Any "current opportunity" claim is at least 5 minutes to an hour old and must be presented as indicative only.
