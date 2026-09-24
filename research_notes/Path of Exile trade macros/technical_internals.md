# Path of Exile trade macros: technical internals (as of Sept 2026)

Scope: how price-check overlays (Awakened PoE Trade "APT", Exiled Exchange 2 "EE2", Sidekick) capture item data and talk to pathofexile.com and third-party price sources, with PoE 1 PC realm as the focus. Findings marked **[observed 2026-09-23]** come from live requests made during this research (anonymous, no POESESSID, `User-Agent: pathofflipper-research/0.1 (contact: ...)`). Everything else is cited to source code or docs.

Tool versions current at time of writing: APT `v3.29.108` (2026-09-09), Exiled Exchange 2 `v0.16.3` (2026-09-06), Sidekick `v2026.9.2` (2026-09-06) — [GitHub releases API: SnosMe/awakened-poe-trade](https://github.com/SnosMe/awakened-poe-trade/releases), [Kvan7/Exiled-Exchange-2](https://github.com/Kvan7/Exiled-Exchange-2/releases), [Sidekick-Poe/Sidekick](https://github.com/Sidekick-Poe/Sidekick/releases).

## 1. How do tools capture item data and parse item text?

### Takeaway
All three tools capture items by simulating the game's copy shortcut and reading the clipboard; APT also tails `Client.txt`, but only to stream log lines to its widgets. Nothing reads game memory. Since patch 3.29, a plain Ctrl+C in PoE 1 always copies the advanced ("Ctrl+Alt+C") mod description, so the parser always gets mod tiers and ranges.

### Cited Findings
- APT sends keystrokes with `uiohook.keyToggle()`. The copy chord is "Ctrl + C" merged with a `showModsKey`. The code comment reads *"3.29: Copying an item's text now always copies the advanced description format."* On non-mac platforms, modifier keys the user is already holding are filtered out so they are not toggled twice. — [APT main/src/shortcuts/Shortcuts.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/main/src/shortcuts/Shortcuts.ts)
- APT registers its shortcuts only while the game window is focused: `poeWindow.on('active-change', ...)` registers or unregisters them. — [Shortcuts.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/main/src/shortcuts/Shortcuts.ts)
- After the keypress, APT polls the clipboard every **48 ms** for up to **500 ms**. It accepts text only if it starts with a localized item header: `"Item Class: "` in English, `"Класс предмета: "` in Russian, `"Classe d'objet: "` in French, and equivalents for DE, PT, ES, TH, KO and ZH. It can optionally restore the user's previous clipboard within about **120 ms**, and it throttles repeat actions to avoid the game's "Too many actions" disconnect. — [APT main/src/shortcuts/HostClipboard.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/main/src/shortcuts/HostClipboard.ts)
- APT's `GameLogWatcher` tails `Client.txt` with `watchFile(logFile, { interval: 450 })` and reads new bytes in 64 KB chunks from the last offset. It does not parse events; it broadcasts the raw lines (`MAIN->CLIENT::game-log`) to the renderer. Default paths are `C:\Program Files (x86)\Grinding Gear Games\Path of Exile\logs\Client.txt` (or the Steam path) on Windows, a Wine path on Linux, and `~/Library/Caches/com.GGG.PathOfExile/Logs/Client.txt` on macOS. — [APT main/src/host-files/GameLogWatcher.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/main/src/host-files/GameLogWatcher.ts)
- APT's parser is a pipeline of section parsers run over the clipboard text, which is split into blocks by `--------` separator lines. The parsers include `parseUnidentified`, `parseSynthesised`, `parseItemLevel`, `parseGem`, `parseArmour`, `parseWeapon`, `parseFlask`, `parseStackSize`, `parseCorrupted`, `parseInfluence`, `parseMap`, `parseSockets`, `parseHeistContract`, `parseLogbookArea` and others. Mod lines go through an `advanced-mod-desc` module (`isModInfoLine`, `groupLinesByMod`, `parseModInfoLine`) and through stat translation matching (`linesToStatStrings`, `tryParseTranslation`) to map text onto trade stat ids. — [APT renderer/src/parser/Parser.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/parser/Parser.ts)
- Sidekick is a Blazor web app hosted in WPF with WebView2 (a Docker build also exists). It triggers price checks through the Ctrl+C / Ctrl+Alt+C copy flow and supports both PoE 1 and PoE 2. — [Sidekick README](https://github.com/Sidekick-Poe/Sidekick)
- GGG's policy: *"We don't encourage players to download or run tools on their machine."* Macros must be manually invoked and perform a single function, and apps that interact with game files break the Terms of Use. — [GGG developer docs](https://www.pathofexile.com/developer/docs)

### Inferences
- A currency-flipping tool needs none of this capture machinery. Bulk currency data comes straight from the APIs in Sections 2 and 4. Clipboard capture only matters if you want an in-game "check this stack" hotkey.
- The one-keypress-to-one-copy-to-one-request pattern is how these overlays stay inside the "single function per keypress" macro rule. An automated or looping trade bot would not fit that rule.

### Gaps
- I did not verify Sidekick's clipboard polling timings or its Client.txt usage from source, only from the README.
- I did not check Exiled Exchange 2's source separately. By lineage it is widely understood to be an APT fork adapted for PoE 2 (same Electron, uiohook and clipboard design), but no document here confirms that.

## 2. Which pathofexile.com endpoints do they call? Request/response shapes, league and realm

### Takeaway
The overlays use the **undocumented, cookie-optional trade site API** at `https://www.pathofexile.com/api/trade/...`: `POST search/{league}` followed by `GET fetch/{ids}?query={id}` for items, and `POST exchange/{league}` for bulk currency. The league goes in the URL path. Realm is picked by URL prefix (e.g. `/api/trade/search/xbox/{league}`) or by a different host for Garena, Tencent or Kakao. All of these calls worked anonymously on 2026-09-23.

### Cited Findings
- APT builds endpoints as `${getTradeEndpoint()}/api/trade/search/${leagueId}` (POST), `/api/trade/fetch/${resultIds.join(',')}` (GET) and `/api/trade/exchange/${leagueId}` (POST). — [APT pathofexile-trade.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-trade.ts), [APT pathofexile-bulk.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-bulk.ts)
- APT chooses the host by language and realm: `www.pathofexile.com` by default, `ru.pathofexile.com`, `pathofexile.tw` (Traditional Chinese), and `poe.kakaogames.com` (Korean). The realm config is `'pc-ggg' | 'pc-garena'`. — [APT renderer/src/web/Config.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/Config.ts)
- The search request body is `{ query: { status: { option: 'online'|'securable'|'available'|'any' }, name?, type?, stats: [{ type: 'and'|'if'|'count'|'not'|..., filters: [...] }], filters: { type_filters, socket_filters, misc_filters, trade_filters, ... } }, sort: { price: 'asc' } }`. — [APT pathofexile-trade.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-trade.ts)
- The bulk exchange request body is `{ engine: 'new', query: { have: string[], want: string[], status: { option: 'online'|'onlineleague'|'any' }, minimum?: number }, sort: { have: 'asc' } }`. APT filters offers by `exchange.currency`, sorts by `exchange.amount / item.amount` and keeps the top 20. — [APT pathofexile-bulk.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-bulk.ts)
- **[observed 2026-09-23]** The exchange response for `POST /api/trade/exchange/Standard` with `{"query":{"status":{"option":"online"},"have":["chaos"],"want":["divine"]},"sort":{"have":"asc"},"engine":"new"}` has top-level keys `id`, `complexity` (null), `result` and `total`. Unlike search, `result` is a **dict keyed by listing id** and includes the listing inline, so no fetch step is needed. Each value is `{id, item: null, listing: {indexed, account: {name, online: {league, status?}, lastCharacterName, language, realm: "pc"}, offers: [{exchange: {currency: "chaos", amount: 3, whisper: "{0} Chaos Orb"}, item: {currency: "divine", amount: 1, stock: 13, id, whisper: "{0} Divine Orb"}}], whisper: "@Char Hi, I'd like to buy your {0} for my {1} in Standard"}}`. Only 6 results came back for this pair in Standard. — live request (no public URL)
- **[observed 2026-09-23]** `POST /api/trade/search/Standard` with `{"query":{"status":{"option":"online"},"type":"Divine Orb"},"sort":{"price":"asc"}}` returned `{id, complexity: 3, result: [<64-hex ids>...], total}`. Then `GET /api/trade/fetch/{10 comma-joined ids}?query={searchId}` returned `result[]` items shaped `{id, listing: {method: "psapi", indexed, stash: {name, x, y}, price: {type: "~price", amount: 3, currency: "chaos"}, account: {...}, whisper}, item: {verified, w, h, icon, stackSize, maxStackSize, league, id, name, typeLine, baseType, ilvl, identified, properties, explicitMods, descrText, frameType, frameTypeId, extended}}`. — live request
- Community convention (not verified here) caps fetch at **10 ids per call**. APT's code doesn't show the cap in the excerpt reviewed. — [APT pathofexile-trade.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-trade.ts)
- **[observed 2026-09-23]** `GET /api/trade/data/leagues` returns `{"result":[{"id":"Allflame","realm":"pc","text":"Allflame"}, {"id":"Hardcore Allflame",...}, {"id":"Ruthless Allflame",...}, {"id":"HC Ruthless Allflame",...}, {"id":"Standard",...}, ..., {"id":"Allflame","realm":"xbox",...}]`. Each league carries a `realm` of `pc`, `xbox` or `sony`, and this response is Cloudflare-cached (`cf-cache-status: HIT`). — live request
- `GET /api/trade/data/static` returns `{result: [{id: "Currency", label, entries: [{id, text, image}]}, ...]}`. The first currency ids are `alt`, `fusing`, `alch`, `chaos`, `gcp`, `exalted`, `chrome`, and these short ids are what `have`/`want` take in exchange queries. `/api/trade/data/stats` (stat id and text lookups, e.g. `explicit.stat_...`) and `/api/trade/data/items` (base types) are also CDN-cached static JSON. — [pathofexile.com/api/trade/data/static](https://www.pathofexile.com/api/trade/data/static); stats header check observed live

### Inferences
- For a PoE 1 flipping tool, **`/api/trade/exchange/{league}` is the only live-orderbook call you need**. One POST returns up to about 20 listings, each with stock and ratio, with no fetch step. Use `data/static` to map ids to names.
- The `status.option` choice matters for flipping. `online` includes AFK sellers (the `online.status: "afk"` field). `onlineleague` narrows to players online in that league.
- Realm prefix is not shown in APT's code. The `/api/trade/search/{realm}/{league}` pattern for xbox and sony is community knowledge that I did not verify here.

### Gaps
- There is no official documentation of the `/api/trade/*` shapes. GGG's developer docs don't mention the trade API at all. — [GGG developer docs](https://www.pathofexile.com/developer/docs)
- I didn't verify the maximum number of exchange results per request, or pagination beyond about 20.

## 3. Rate limiting: headers, Retry-After, client throttling

### Takeaway
GGG uses a multi-window, per-policy limiter. Each response names its policy and gives rules as `hits:period:penalty` triples, with a matching `-State` header showing the current count. The trade site's anonymous limits are tight: search allows 5 per 10 s, and exchange allows 5 per 15 s and only 30 per 5 min. Overlays mirror these headers into client-side sliding-window limiters and refuse to queue long waits.

### Cited Findings
- Official header format: `X-Rate-Limit-Policy` (policy name), `X-Rate-Limit-Rules` (comma list such as `ip`, `account`, `client`), and `X-Rate-Limit-{rule}` holding comma-separated triples of *max hits : period in seconds : restriction in seconds if exceeded* (e.g. `X-Rate-Limit-Client: 10:5:10`). `X-Rate-Limit-{rule}-State` uses the same format, with the third number being the active restriction time (0 when not limited). `Retry-After` gives the seconds to wait. — [GGG developer docs](https://www.pathofexile.com/developer/docs)
- **[observed 2026-09-23, anonymous IP]**:
  - `POST /api/trade/exchange/Standard` → `x-rate-limit-policy: trade-exchange-request-limit`, `x-rate-limit-rules: Ip`, `x-rate-limit-ip: 5:15:60,10:90:300,30:300:1800`, `x-rate-limit-ip-state: 1:15:0,1:90:0,1:300:0`
  - `POST /api/trade/search/Standard` → `trade-search-request-limit`, `x-rate-limit-ip: 5:10:60,15:60:300,30:300:1800,600:21600:3600`
  - `GET /api/trade/fetch/...` → `trade-fetch-request-limit`, `x-rate-limit-ip: 12:4:10,16:12:300,50:300:300,1000:21600:1800`
  - `GET /api/trade/data/*` → no rate-limit headers (served from the Cloudflare cache).
  - `GET https://web.poecdn.com/api/currency-exchange` → no rate-limit headers, `cache-control: max-age=31367584`. The project's own notes also saw no rate-limit headers on this host. — [specs/exchange-api-observations.md](../../specs/exchange-api-observations.md)
- APT starts each category (`SEARCH`, `EXCHANGE`, `FETCH`) with a conservative `new RateLimiter(1, 5)` (1 request per 5 s). `_adjustRateLimits` then reads `x-rate-limit-rules`, `x-rate-limit-{rule}` and `x-rate-limit-{rule}-state` from each response and rebuilds the limiter set, adding a user-configurable `apiLatencySeconds` to each window as a safety margin. `preventQueueCreation` estimates the wait across all limiters and throws `"Retry after N seconds"` instead of queueing when the delay would exceed **1500 ms**. — [APT trade/common.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/common.ts)
- APT's `RateLimiter` is a sliding-window "borrow" stack. Each request takes a slot that frees itself after `window * 1000` ms, and waiters block on the oldest slot's promise. It has no 429 or `Retry-After` logic of its own; header syncing happens in common.ts. — [APT RateLimiter.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/RateLimiter.ts)
- Other client authors note there is no endpoint that only returns limits, so a client learns the rules from its first real request. Firing many requests concurrently gets you limited, and about 5 concurrent requests has been treated as safe. — [moepmoep12/poe-api-ts](https://github.com/moepmoep12/poe-api-ts)

### Inferences
- The exchange limit's 5-minute window (30 requests, 30-minute lockout) is the binding constraint for a poller. Polling N currency pairs continuously means at most about 6 pairs per minute per IP. Plan to exceed the third window's hits and you are locked out for 1800 s.
- A robust client should (a) start conservative, (b) parse every triple on every response, including different policies per endpoint, (c) keep one sliding-window limiter per `(policy, rule, window)`, (d) on 429 honor `Retry-After` and the third number of `-State`, and (e) never retry into an active restriction.
- Logged-in (POESESSID) requests likely also carry an `Account` rule. I did not observe this, since all probes were anonymous.

### Gaps
- I did not observe `Account` rule values, 429 bodies, or whether limits differ with a POESESSID. Published limits change without notice, so treat the numbers above as a snapshot.

## 4. Secondary data sources: poe.ninja, poeprices.info, game data

### Takeaway
poe.ninja is the standard source of aggregated prices. Its documented 2025+ API is namespaced `/poe1/api/economy/...`, while APT uses an undocumented "dense overviews" endpoint that fetches everything in one call. poeprices.info provides ML price ranges for rare items via a base64 item-text GET.

### Cited Findings
- Documented poe.ninja endpoints — [poe.ninja API docs](https://poe.ninja/docs/api):
  - `GET /poe1/api/economy/leagues` → `[{id, name}]`
  - `GET /poe1/api/economy/exchange/current/overview?league=&type=` → `lines[]` (`id, primaryValue, volumePrimaryValue, maxVolumeCurrency, maxVolumeRate, sparkline`) and `core` (`primary, secondary, rates, items`). This is currency-exchange-derived pricing.
  - `GET /poe1/api/economy/stash/current/item/overview?league=&type=` → lines with `chaosValue, divineValue, exaltedValue, count, listingCount, sparkLine` plus item metadata.
  - `GET /poe1/api/economy/stash/current/currency/overview?league=&type=` (PoE 1 only) → `chaosEquivalent, pay, receive, paySparkLine, receiveSparkLine`.
  - Responses are HTTP-cached for about 5 minutes (ETag). PoE 1 overviews update about every 15 minutes and PoE 2 about hourly. The docs ask for *"a descriptive User-Agent that identifies your app and a contact"*, reasonable concurrency, no replication of the site, and warn that there is *"no versioning and no SLA"*.
- The legacy paths `/api/data/currencyoverview` and `/api/data/itemoverview` still appear in community docs but are superseded by the `/poe1/`-prefixed API. — [ayberkgezer/poe.ninja-API-Document](https://github.com/ayberkgezer/poe.ninja-API-Document), [poe.ninja API docs](https://poe.ninja/docs/api)
- APT fetches `poe.ninja/poe1/api/economy/current/dense/overviews?league={id}&language=en` (undocumented). It updates every **31 min** (`UPDATE_INTERVAL_MS`) and retries every **4 min**, only for popular `pc-ggg` leagues. It derives the chaos/divine rate from the "Divine Orb" entry, requiring at least 30c. Deep links take the form `https://poe.ninja/poe1/economy/{league}/{category}/{details}`. — [APT renderer/src/web/background/Prices.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/background/Prices.ts)
- poeprices.info: `GET https://www.poeprices.info/api?i={base64(utf8 item text)}&l={league}&s={source-name}`. The response contains `min`, `max`, `currency` (`chaos`|`divine`|`exalt`), `pred_confidence_score`, `pred_explanation: [[string, number]]`, `error` and `error_msg`. Feedback goes to `POST https://www.poeprices.info/send_feedback` as form data with `selector`, `feedbacktxt`, `qitem_txt`, `source`, `min`, `max`, `currency` and `league`. — [APT price-prediction/poeprices.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/price-prediction/poeprices.ts)
- Sidekick lists its data sources as the official trade API, poe.ninja, poeprices.info, poedb.tw, poewiki.net and poe2scout.com (PoE 2). — [Sidekick README](https://github.com/Sidekick-Poe/Sidekick)

### Inferences
- For flipping, poe.ninja's exchange overview (`maxVolumeRate`, `volumePrimaryValue`) is a cheap way to find high-volume pairs before spending scarce trade-API exchange calls. poeprices is irrelevant to currency.

### Gaps
- I did not verify whether APT, EE2 or Sidekick use RePoE or other data exports. APT's parser relies on bundled stat-translation data, but I didn't confirm how it's generated. I also didn't verify RePoE's current maintenance status.

## 5. OAuth developer API and the Currency Exchange endpoint

### Takeaway
The overlays don't use GGG's OAuth API for price checks. The official Currency Exchange history endpoint is now documented as a **public, unauthenticated CDN endpoint** giving **hourly historical aggregates**, not live order books. Live exchange listings still come only from the unofficial `/api/trade/exchange`.

### Cited Findings
- `GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]` is listed as a public API with no scope. Realm is `pc` (default), `xbox`, `sony` or `poe2`. `id` is an hour-truncated unix timestamp cursor, and the response is `{next_change_id, markets: [{league, market_id, market_pair, volume_traded, lowest_stock, highest_stock, lowest_ratio, highest_ratio}]}`. The docs say *"responses from this endpoint are purely historical"* and that matching `next_change_id` marks the end. — [GGG API reference](https://www.pathofexile.com/developer/docs/reference)
- The project's own measurements: PC has no realm segment (`/pc/<id>` returns 404), the current hour returns 404 with an empty `markets`, published hours are immutable (cache max-age about one year), and history starts at 2024-07-26 20:00 UTC. — [specs/exchange-api-observations.md](../../specs/exchange-api-observations.md)
- **[observed 2026-09-23]** `GET https://api.pathofexile.com/currency-exchange` returns HTTP 401. The OAuth-host variant still exists but requires a token. (Earlier docs placed it under a `service:cxapi` scope; that is from memory and not re-verified.)
- Official OAuth scopes listed include `service:psapi` (Public Stash Tabs, PoE 1 only, with a documented *"5-minute delay"*), `service:leagues`, `service:leagues:ladder`, `account:profile`, `account:characters`, `account:stashes` (PoE 1 only), `account:item_filter` and others. None covers trade search. — [GGG API reference](https://www.pathofexile.com/developer/docs/reference)
- OAuth follows OAuth 2.1 with registered applications. — [GGG developer docs](https://www.pathofexile.com/developer/docs)

### Inferences
- The difference: the trade site API is live and per-listing (who sells what at which ratio right now), unofficial, and IP-limited to about 30 exchange calls per 5 min. The Currency Exchange API is official, hourly, aggregated (volume, min/max ratio and stock per pair), and unthrottled on the CDN, but it lags by at least one hour. A flipper can combine them: use the CX history to rank pairs by volume and spread, then use trade `exchange` to confirm the current book.
- The in-game Currency Exchange market (3.25+) can't be queried live through any official API. Only the hourly digest is exposed.

### Gaps
- I did not verify whether any overlay (APT, EE2, Sidekick) consumes the Currency Exchange digest. No evidence was found that they do.

## 6. POESESSID and User-Agent conventions

### Takeaway
Trade search, fetch and exchange work **without POESESSID** as of 2026-09-23. The session cookie is optional and mainly needed for account-linked features. GGG requires OAuth apps to send a structured `User-Agent`, and poe.ninja asks for an app name plus contact.

### Cited Findings
- **[observed 2026-09-23]** Anonymous `POST /api/trade/search`, `GET /api/trade/fetch` and `POST /api/trade/exchange` all returned HTTP 200 with data, using only a custom User-Agent and no cookie.
- APT's trade modules contain no POESESSID or cookie handling. Requests go through `Host.proxy()` in the Electron main process, which avoids browser CORS. — [APT pathofexile-trade.ts](https://github.com/SnosMe/awakened-poe-trade/blob/master/renderer/src/web/price-check/trade/pathofexile-trade.ts)
- Some third-party trade clients ask users for their POESESSID cookie from browser devtools. The token only authenticates trade requests. — [HivemindOverlord/poe2-mcp trade auth guide](https://glama.ai/mcp/servers/@HivemindOverlord/poe2-mcp/blob/20a542602c458050a11aaf36584363dc53470d40/docs/guides/TRADE_AUTH_SETUP_GUIDE.md)
- GGG's required User-Agent format is `User-Agent: OAuth {$clientId}/{$version} (contact: {$contact}) ...`, for example `OAuth mypoeapp/1.0.0 (contact: mypoeapp@gmail.com) SomeOptionalThingHere`. — [GGG developer docs](https://www.pathofexile.com/developer/docs)
- poe.ninja: *"Send a descriptive User-Agent that identifies your app and a contact."* — [poe.ninja API docs](https://poe.ninja/docs/api)

### Inferences
- A POESESSID is a full web session credential. A flipping tool should avoid collecting it unless it needs account-bound features. Anonymous access is enough for exchange price discovery.
- For the unofficial endpoints, use a GGG-style UA (`appname/version (contact: email)`) so GGG can contact you rather than block you.

### Gaps
- Whether a POESESSID raises limits (an `Account` rule) or unlocks different result sets wasn't tested. It's also unclear whether GGG enforces the `OAuth ...` UA prefix on non-OAuth endpoints.
