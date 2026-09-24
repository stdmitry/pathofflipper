# GGG Policy and Terms for Trade Macros and Third-Party Trade Tools (PoE 1 PC, as of Sept 2026)

Method note: primary sources were fetched through a summarizing fetch tool on 2026-09-23. Quoted wording came back through that tool, so check it against the live pages before quoting in anything public. The developer docs pages are rendered with JavaScript, so a raw curl did not return the text.

## 1. Terms of Use and the "one action per keypress" macro rule: where it is stated and how it has been clarified

### Takeaway
The binding rule today is in the official Developer Docs "Third-Party Policy": a macro must be triggered manually, each trigger has one set function, and that function may do only one thing that interacts with the game. Timers and screen-reading triggers are banned. Programs that touch the game client or its files lead to immediate account termination. The Terms of Use (last updated October 2024) do not mention macros by name. Instead they ban bots, third-party clients, data-extraction tools and reverse engineering in general terms. The "1 keypress = 1 server action" wording is a long-standing staff and community shorthand for the same rule.

### Cited Findings
- Developer Docs, Third-Party Policy, rules for "Executable apps running independently": "Macros must be invoked manually by the user"; "Each macro invocation must have one set function"; "The resulting function must only perform one action that interacts with the game." Automated triggers such as timers or screen-reading are prohibited. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Developer Docs, "Executable apps interacting with game files": "This behaviour is strictly against our Terms of Use" and results in immediate account termination. Websites and web apps are described as the lowest-risk kind of tool and the recommended one. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Terms of Use, last updated October 2024, Section 7 restrictions:
  - 7c: no "automated software or 'bots' in relation to your access or use of the Website, Materials or Services"
  - 7e: no connecting "to the Servers through any software other than the authorised game client software"
  - 7f: no "data gathering and extraction tools or software to extract information from the Website"
  - 7h: no performing in-game services "for any form of compensation outside of PoE" (the RMT clause)
  - 7i: no reverse engineering, decompiling, or seeking to establish "the technical processes, operations and communication protocols"
  
  Source: [PoE Terms of Use](https://www.pathofexile.com/legal/terms-of-use-and-privacy-policy)
- Terms of Use, enforcement: a breach "immediately terminates the Licence". Under Clause 17, GGG may cancel the account without prior notice or explanation, block the IP address, and remove Virtual Items and Points. — [PoE Terms of Use](https://www.pathofexile.com/legal/terms-of-use-and-privacy-policy)
- Community restatement: "1 key press = 1 server action". Macros that do more than one action, or that fire on a timer, are bannable. A single-key `/oos` or `/remaining` command, or casting one aura, is fine. A timer that repeats actions, or a key that casts all auras, is not. A macro that fires all 5 flasks at once is not allowed. These threads attribute the rule to Chris Wilson, but the original staff post was not found. — [Steam discussion](https://steamcommunity.com/app/238960/discussions/0/648811670600001418); [Steam discussion](https://steamcommunity.com/app/238960/discussions/0/1743355067091075405)
- Bex_GGG, 2020: "You may not run programs that interact with the Path of Exile game client." Also: "It's okay to run things that are entirely external to the game." — [devtrackers.gg mirror of GGG staff posts](https://devtrackers.gg/pathofexile/p/cdea4d78-psa-waves-of-players-being-banned-for-use-of-third-party-tool-poe-overlay)

### Inferences
- Over time the rule moved from forum posts ("1 keypress = 1 server action", Chris Wilson and Bex in the 2010s to 2020) into the Developer Docs Third-Party Policy. The docs version adds that a trigger must be manual and names screen-reading as a banned trigger. That matters for a flipping tool: even a single action is not allowed if it fires automatically because of something detected on screen.
- Since the ToS never mentions macros, the Developer Docs policy is the most specific official source to cite.

### Gaps
- I did not find the original Chris Wilson post or its date on pathofexile.com. It is attributed to him only in community threads.
- I did not find a dated changelog for the Third-Party Policy, so it is unknown when the "screen-reading" wording was added.

## 2. Which trade automations are allowed and which are not

### Takeaway
Allowed: tools that run entirely outside the game (websites, price-check overlays that read the clipboard, single-action hotkeys such as sending one whisper or opening one search), as long as each keypress triggers one game-affecting action. Not allowed: auto-buying, auto-trading bots, clicking on a timer or on screen detection, multi-action macros, and anything that reads or changes game memory or files. No community tool has ever been officially approved, so "compliant" tools remain use at your own risk.

### Cited Findings
- Allowed: anything "entirely external to the game". Not allowed: programs that "interact with the Path of Exile game client". — [Bex_GGG via devtrackers.gg](https://devtrackers.gg/pathofexile/p/cdea4d78-psa-waves-of-players-being-banned-for-use-of-third-party-tool-poe-overlay)
- Not allowed: timer or screen-reading triggers, and more than one game action per trigger. Game-file interaction gets immediate termination. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Not allowed: bots and automated software (ToS 7c), third-party clients (7e), data-extraction tools on the website (7f), reverse engineering (7i). — [PoE Terms of Use](https://www.pathofexile.com/legal/terms-of-use-and-privacy-policy)
- Awakened PoE Trade's own FAQ (community source, not GGG) says the tool follows the rules: one server action per button press, no memory reading or changing, no automation. It also says GGG has never officially approved any community tool, so its use is a grey area at the user's own risk. — [Awakened PoE Trade FAQ](https://snosme.github.io/awakened-poe-trade/faq); [pathofexile.com forum thread "Awakened PoE Trade Overlay (Bannable?)"](https://www.pathofexile.com/forum/view-thread/3184895)
- Community view: streamers use clipboard-based price-check overlays openly without being banned, while "multi-action macros or automation programs risk a ban." — [Steam discussion](https://steamcommunity.com/app/2694490/discussions/0/598514132636994882/?ctp=4)

### Inferences
- For a flipping tool, anything that reads public data (APIs, poe.ninja-style data) and shows advice in a website or separate app is the lowest-risk design. GGG's docs call it the recommended kind of tool.
- A "whisper hotkey" (one key sends one prepared whisper) fits the rule as written. Automatically sending whispers when a deal is found does not, because the trigger is automatic.
- Auto-placing or auto-accepting Currency Exchange orders through the client would break both the macro rule and ToS 7c/7e. There is no official API for placing orders.

### Gaps
- I found no GGG statement that names specific tools (Awakened PoE Trade, Exiled Exchange 2, Sidekick) as allowed.
- I found no official statement about stash-tab search (Ctrl+F) macros in particular. Under the rule, one paste-and-search per keypress looks allowed, but that is my own inference.

## 3. Third-party developer policy: OAuth, scopes, API terms, User-Agent, rate limits and consequences

### Takeaway
Registered apps use OAuth 2.1. `service:*` scopes (including `service:psapi` and `service:cxapi`) require a confidential client using the client_credentials grant. As of Sept 2026, the docs say GGG is "currently unable to process new applications." The Currency Exchange history endpoint on `web.poecdn.com` needs no authentication, according to both the docs and this project's own observations. Every request must send the required User-Agent format. If an app often goes over rate limits, sends too many invalid requests, or breaks policy, GGG can revoke access "without notice".

### Cited Findings
- Registration is closed: "We are currently unable to process new applications." Existing apps are managed from the account profile. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs)
- Scopes:
  - Account scopes: `account:profile`, `account:leagues`, `account:stashes`, `account:characters`, `account:league_accounts`, `account:item_filter`. They use Authorization Code plus Refresh Token. Tokens last 28 days for confidential clients and 10 hours for public clients.
  - Service scopes: `service:leagues`, `service:leagues:ladder`, `service:pvp_matches`, `service:pvp_matches:ladder`, `service:psapi` ("for access to the Public Stash API") and `service:cxapi` ("for access to the Currency Exchange API"). They require "a confidential client with the `client_credentials` grant type" and the tokens do not expire.
  - Public clients "Cannot use any `service:*` scopes."
  
  Source: [PoE Developer Docs — Authorization](https://www.pathofexile.com/developer/docs/authorization)
- Currency Exchange endpoint:
  - URL: `https://web.poecdn.com/api/currency-exchange[/<realm>][/<id>]`. Realm can be `xbox`, `sony` or `poe2`; PoE1 PC is the default.
  - Returns hourly digests of trade history across all leagues.
  - "responses from this endpoint are purely historical", and "there isn't any way to get data from the current hour".
  - GGG may remove old history.
  - The fetch tool reported that no authentication is needed, even though the Authorization page lists `service:cxapi`. This project's code already calls the endpoint without OAuth: see `src/exchange/client.ts` and `specs/exchange-api-observations.md`.
  
  Source: [PoE Developer Docs — Reference](https://www.pathofexile.com/developer/docs/reference#currency-exchange)
- Public Stash API:
  - URL: `https://api.pathofexile.com/public-stash-tabs[/<realm>]`. Needs `service:psapi`.
  - Realms: PoE1 PC by default, plus xbox and sony. It is PoE1 only.
  - "There is currently a 5-minute delay on results using this API."
  
  Source: [PoE Developer Docs — Reference](https://www.pathofexile.com/developer/docs/reference)
- User-Agent is required in this format: `User-Agent: OAuth {$clientId}/{$version} (contact: {$contact})`. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Other developer guidelines: keep credentials safe, never share them or embed keys in distributed binaries, and register one product per application. Reverse-engineering endpoints not in the docs breaks ToS 7i. — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Required disclaimer: tools must not suggest they are made or authorised by GGG, and must include "This product isn't affiliated with or endorsed by Grinding Gear Games in any way." — [PoE Developer Docs](https://www.pathofexile.com/developer/docs/index)
- Rate limits are dynamic and reported in response headers (`X-Rate-Limit-Policy`, `X-Rate-Limit-Rules`, and so on). Going over returns 429 with `Retry-After`. "Exceeding these limits frequently will result in your application access being revoked." Invalid 4xx requests are also monitored, and too many of them restrict access. GGG may remove access "without notice at our discretion." — [PoE Developer Docs](https://www.pathofexile.com/developer/docs)
- Old trade-site limits (Feb 2021, per IP): search 5/12s, 15/62s, 30/302s; exchange 5/17s, 10/92s, 30/302s; fetch 12/6s, 16/14s. These are a 2021 snapshot. Today's limits are set by the headers. The fetch tool contradicted itself on whether the poster, Verdale, is GGG staff. — [PoE forum thread 3056323](https://www.pathofexile.com/forum/view-thread/3056323)
- Novynn (GGG) on User-Agent obfuscation: "We really don't condone tools obfuscating their user agent." — [devtrackers.gg](https://devtrackers.gg/pathofexile/p/cdea4d78-psa-waves-of-players-being-banned-for-use-of-third-party-tool-poe-overlay)

### Inferences
- **User-Agent problem in this project.** The project's User-Agent is `pathofflipper/<version> (contact: ...)` (see README.md). It does not match the documented `OAuth {clientId}/{version} (contact: ...)` format. Without a registered client there is no clientId to send. Keeping a clear app name and contact is the closest you can get to following the rule. It is still worth noting as a deviation.
- The trade site (`/api/trade/...`) is not in the developer docs. Automated querying of it falls under the ToS 7i ban on undocumented endpoints and 7f on data extraction, even though many community tools do it at low volume.
- The docs list the cxapi endpoint as unauthenticated but also define `service:cxapi` as a scope. GGG may require OAuth later, so plan for that possibility.

### Gaps
- There is no public date for when new app registrations were paused, or for when they will reopen.
- I found no written API terms beyond the Developer Docs guidelines and the ToS (for example, no separate data-licensing or commercial-use terms).
- I could not confirm whether `service:cxapi` gives anything more than the public endpoint (such as the current hour or a different host).

## 4. Documented enforcement actions

### Takeaway
There is one well-documented GGG statement about a tool causing account restrictions: PoE Overlay in April 2020. Those were temporary account locks because the tool flooded GGG's site with rate-limited requests, not bans for using the tool itself. Broad ban waves (March 2026, forum-reported) and an RMT crackdown (PoE 2, April 2026, press-reported) are documented, but GGG did not publish per-account reasons. I found no public case of an account banned specifically for a trade overlay.

### Cited Findings
- PoE Overlay, 2020. Novynn reported that on April 28th poe-overlay generated 6.7M requests, 6.1M of which got 429 responses, and "5.9 million of those rate-limited requests were from 3 unique accounts." Bex said the accounts were locked for "hammering the ever-living sh*t out of our website." These were locks, not permanent bans. — [devtrackers.gg](https://devtrackers.gg/pathofexile/p/cdea4d78-psa-waves-of-players-being-banned-for-use-of-third-party-tool-poe-overlay)
- March 20, 2026: a PoE 1 forum thread about a ban wave describes permanent bans with no stated violation and appeals taking more than 11 days. Players guessed at botting, macros or RMT. There was no official GGG statement, only a Council Supporter (not staff) commenting on the appeals queue. — [PoE forum thread 3925951](https://www.pathofexile.com/forum/view-thread/3925951)
- April 2, 2026: RMT crackdown in PoE 2 Early Access aimed at both sellers and buyers ("whales"). The article cites a GGG warning message, via PCGamesN, saying GGG takes "Real Money Trading very seriously". No numbers were given. — [AllKeyShop](https://www.allkeyshop.com/blog/en-us/path-of-exile-2-rmt-ban-wave-economy-news-d/) (secondary source)
- Older player report: "Banned for using Trade-Macro". This is a player claim with no GGG confirmation found. — [PoE forum thread 2488502](https://www.pathofexile.com/forum/view-thread/2488502)
- Community view: there are no confirmed bans for price-check overlays, while macros are "the only hard no" from GGG. — [Steam discussion](https://steamcommunity.com/app/2694490/discussions/0/598514132636994882/?ctp=3)

### Inferences
- For an API client, the most likely real-world penalty is being throttled or locked for too many requests (429s), not a game ban. Following `Retry-After` and the rate-limit headers, as this project already does, is the main safeguard.
- Ban waves come without explanations, and appeals are slow. That raises the cost of any grey-area client automation.

### Gaps
- I found no official GGG post about scraping bans on the trade site or tools being told to change after 2020.
- I found no official GGG ban numbers for the 2026 waves. The PoE 2 RMT details come from a secondary source.

## 5. Rule changes tied to the Currency Exchange (Faustus) and the trade site, 2024–2026

### Takeaway
The Currency Exchange (Faustus) arrived in PoE 1 with Settlers of Kalguur (3.25, July 2024). Its main anti-bot measure is a design choice: orders cost gold, and gold cannot be traded. I found no macro or ToS rule written specifically for the exchange. Its history became available as a documented Currency Exchange API that covers PC, console and PoE 2 realms. The ToS was last updated in October 2024.

### Cited Findings
- The Currency Exchange is used through Faustus in Kingsmarch. It was introduced with patch 3.25, Settlers of Kalguur. Gold "can't be traded with other players to ensure that bots don't load up the free Steam game and abuse the new system." — [PCGamesN](https://www.pcgamesn.com/path-of-exile/currency-exchange-market) (secondary source; a u4gm blog wrongly says 3.26: [u4gm](https://www.u4gm.com/poe/blog-poe-1-currency-exchange-market))
- The Currency Exchange API gives hourly historical digests for PoE1 PC (default), xbox, sony and poe2, with no current-hour data. It is the only official source of exchange data. — [PoE Developer Docs — Reference](https://www.pathofexile.com/developer/docs/reference#currency-exchange)
- Terms of Use version: "Last Updated October 2024". — [PoE Terms of Use](https://www.pathofexile.com/legal/terms-of-use-and-privacy-policy)
- January 2025: a player on the official forum asked about an API "to perform some high frequency trades on the currency exchange". No staff reply was visible. — [PoE forum thread 3711507](https://www.pathofexile.com/forum/view-thread/3711507)
- Players complain about bots and currency sellers manipulating the PoE 2 exchange. These are player claims only. — [PoE forum thread 3645488](https://www.pathofexile.com/forum/view-thread/3645488)
- The Public Stash API is PoE1 only (PC, xbox, sony), while the cxapi also covers poe2. — [PoE Developer Docs — Reference](https://www.pathofexile.com/developer/docs/reference)

### Inferences
- There is no official way to place exchange orders automatically. A flipping tool can analyse hourly history (delayed by about an hour) and suggest trades, but the player must place every order by hand, one action per input.
- Because only past hours are available, a tool cannot legitimately do "high-frequency" exchange trading.

### Gaps
- I could not find what changed in the October 2024 ToS update, or the exact date the Currency Exchange API was released.
- I found no GGG statement on Faustus-specific automation (for example, order-placement macros) and no exchange-specific enforcement.
- I found no documented rule differences between PoE 1 and PoE 2 for macros or tools. The same Developer Docs policy and ToS appear to cover both.
