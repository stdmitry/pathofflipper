# Path of Exile Trade Macro / Price-Check Overlay Tools — Landscape as of September 2026

Method note: GitHub numbers below were pulled live via the GitHub API on 2026-09-23 (stars, forks, license, primary language, last push, latest release). Download totals are summed across all release assets and are **inflated** by auto-updater metadata files (`latest.yml`, `.blockmap`, `.nupkg` deltas); the per-release installer count is a better comparison signal. Reddit could not be searched effectively (web search returned no relevant r/pathofexile threads), so "community standard" claims rely on GitHub signals, maintainer statements in issues, and third-party guides.

## Which tools exist and which are actively maintained in 2026?

### Takeaway
Three tools are actively maintained with releases in Aug–Sep 2026: **Awakened PoE Trade (APT)** for PoE 1, **Exiled Exchange 2 (EE2)**, an APT fork for PoE 2, and **Sidekick**, which supports both games. A second tier is also still maintained: the PoE Overlay Community Fork (PoE 1) and Xiletrade (PoE 1 and 2). POE-TradeMacro (AHK) has been dead since 2020–21. The original Kyusung4698 PoE Overlay (Overwolf) has been dead since 2020–22.

### Cited Findings

**Summary table (GitHub API, 2026-09-23)**

| Tool | Repo | Games | Stack | License | Stars / forks | Latest release | Last push | Status |
|---|---|---|---|---|---|---|---|---|
| Awakened PoE Trade | SnosMe/awakened-poe-trade | PoE 1 | TypeScript / Electron (electron-builder: .exe, .AppImage, universal .dmg) | MIT | 2,583 / 761 | v3.29.108, 2026-09-09 | 2026-09-09 | Active |
| Exiled Exchange 2 | Kvan7/Exiled-Exchange-2 | PoE 2 | TypeScript / Electron (APT fork) | MIT | 1,182 / 161 | v0.16.3, 2026-09-06 | 2026-09-17 | Active |
| Sidekick | Sidekick-Poe/Sidekick | PoE 1 + PoE 2 | C# / .NET: WPF + WebView2 hosting a web app; Linux AppImage | MIT | 510 / 62 | v2026.9.2, 2026-09-06 | 2026-09-20 | Active |
| PoE Overlay Community Fork | PoE-Overlay-Community/PoE-Overlay-Community-Fork | PoE 1 | TypeScript / Electron + Angular | MIT | 491 / 83 | v0.9.0, 2026-09-01 | 2026-09-01 | Maintained, low usage |
| Xiletrade | maxensas/xiletrade | PoE 1 + PoE 2 | C# / .NET (WPF UI) | GPLv3 (UI project); repo has no single SPDX license | 113 | 1.15.10, 2026-08-22 | 2026-09-23 | Active, niche |
| POE-TradeMacro | PoE-TradeMacro/POE-TradeMacro | PoE 1 | AutoHotkey v1 | GPL-3.0 | 918 / 177 | v2.16.0, 2020-06-19 | 2021-08-02 | **Abandoned** (not formally archived) |
| PoE Overlay (original) | Kyusung4698/PoE-Overlay | PoE 1 | TypeScript / Angular on Overwolf | MIT | 693 / 215 | v1.0.10, 2020-08-02 | 2022-04-16 | **Abandoned** |
| Poe Lurker (trade manager, not a price checker) | C1rdec/Poe-Lurker | PoE 1 | C# | MIT | 607 | v2.2.2, 2025-11-15 | 2026-05-18 | Semi-active |
| MercuryTrade (whisper manager, historical) | Exslims/MercuryTrade | PoE 1 | Java | MIT | 496 | 1.0.3.6, 2020-01-06 | 2022-05-20 | **Abandoned** |
| MercuryTrade Community Fork | Morph21/MercuryTrade-Community-Fork | PoE 1 | Java | MIT | 152 | 1.4.2, 2024-12-23 | 2025-01-06 | Dormant since early 2025 |

Sources: [APT repo](https://github.com/SnosMe/awakened-poe-trade), [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases), [EE2 repo](https://github.com/Kvan7/Exiled-Exchange-2), [Sidekick repo](https://github.com/Sidekick-Poe/Sidekick), [PoE Overlay Community Fork](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork), [Xiletrade](https://github.com/maxensas/xiletrade), [POE-TradeMacro](https://github.com/PoE-TradeMacro/POE-TradeMacro), [Kyusung4698/PoE-Overlay](https://github.com/Kyusung4698/PoE-Overlay), [Poe-Lurker](https://github.com/C1rdec/Poe-Lurker), [MercuryTrade](https://github.com/Exslims/MercuryTrade), [MercuryTrade Community Fork](https://github.com/Morph21/MercuryTrade-Community-Fork)

**Awakened PoE Trade (SnosMe)**
- README: "Path of Exile app for price checking". It offers downloads "for Windows & Linux", and it shows gem, rare, unique and currency checks. It credits libuiohook, RePoE, poeprices.info and poe.ninja. — [APT repo](https://github.com/SnosMe/awakened-poe-trade)
- The macOS build was added in v3.22.10005 (2023-12-07). The v3.29.108 release still ships a universal .dmg. — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- Linux gets ongoing work: v3.27.102 (2025-11-02) uses XWayland by default; v3.27.106 improves X11 support via `override-redirect`; v3.28.101 fixes focus on KDE; v3.28.104 (2026-07-24) fixes DPI above 100% and applies `--ozone-platform=x11` by default. — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- Default hotkeys: Ctrl+D price check; Ctrl+Alt+D price check without auto-close; Alt+W wiki; F5 hideout; F9 character select; Shift+Space widget overlay; Ctrl+MouseWheel stash tab navigation. The tool parses the item text that Ctrl+C copies from the game. Filters are user-selected; the docs say it "does not magically check the price of your item." — [APT Quick Start](https://snosme.github.io/awakened-poe-trade/quick-start)
- Release cadence: data updates ship on each league launch (3.26.101 on 2025-06-14, 3.27.101 on 2025-11-01, 3.28.101 on 2026-03-08, 3.29.101 on 2026-07-25), followed by several feature patches per league.
- The 3.29.x releases (Jul–Sep 2026) add Mercenary Warrant, Scrying Orb, Vestigial uniques, Transfigured Vaal gems, Jewelry Catalysts and Timeless Jewel keystone checks. They also add the Kingsmarch Disenchant value, "Merchant Only" and "Buyout Currency" default settings, more pseudo-stat conversion, and a map/item check (explicit mods, Maven Witness reminder, PoEDB links). v3.29.103 fixed CAPTCHA handling. — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- Funding is through Patreon, linked from the README. — [APT repo](https://github.com/SnosMe/awakened-poe-trade)

**Exiled Exchange 2 (Kvan7)**
- README: "Path of Exile 2 overlay program for price checking items … Fork of Awakened PoE Trade." The only official downloads are kvan7.github.io/Exiled-Exchange-2/download and GitHub releases: "any other locations are not official and may be malicious." The README includes steps for migrating APT settings (`apt-data`) and changing `windowTitle` to "Path of Exile 2". — [EE2 repo](https://github.com/Kvan7/Exiled-Exchange-2)
- Assets for v0.16.3 include a Windows setup/portable .exe, a Linux AppImage and a universal macOS .dmg. — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- v0.16.1–0.16.3 (Sep 2026) add Item Editor V2, which previews the price after augments or catalyst quality before you spend the currency. They also add an option to fully hide the overlay and a regex length limit of 250, plus CAPTCHA and cache fixes. — [EE2 v0.16.1 release](https://github.com/Kvan7/Exiled-Exchange-2/releases/tag/v0.16.1)
- Translations moved to Codeberg Weblate in v0.14.0 (2026-03-28). — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- Caution: several unofficial fan or SEO sites exist (exiledexchange2.com, exiledexchange2.net, exiled-exchange2.com). One wrongly says EE2 was "developed by the creators of the original Awakened PoE Trade tool". Another says EE2 is not on macOS, which conflicts with the .dmg in official releases. — [exiledexchange2.com](https://exiledexchange2.com/), [exiled-exchange2.com guide](https://exiled-exchange2.com/blog/how-to-use-exiled-exchange-2/)

**Sidekick**
- README: "A Path of Exile and Path of Exile 2 companion tool. Price check items, check for dangerous map modifiers, and more!" It is a web app running inside WebView2 hosted by WPF. It can also run as a web app (Docker, port 5000). The Linux AppImage needs `dotnet-runtime-8.0`, `webkit2gtk-4.1` and `xsel`. It credits POE-TradeMacro as the "Original Idea", plus poe.ninja, poe2scout.com, poeprices.info, poewiki and poedb. — [Sidekick repo](https://github.com/Sidekick-Poe/Sidekick)
- PoE 2 support arrived in v2024.12.14.1731 (2024-12-14), a few days after PoE 2 early access. The same release "Fixed Path of Exile 1 trade after API changes". — [Sidekick release](https://github.com/Sidekick-Poe/Sidekick/releases/tag/v2024.12.14.1731)
- A Linux build shipped as BETA in v2025.523.1725 (2025-05-23). poe2scout price integration came in 2025.403. v2026.9.1 "Improved Poe2Scout support, including Poe1". — [Sidekick releases](https://github.com/Sidekick-Poe/Sidekick/releases)
- Versions switched to calendar-style tags (v2026.9.2). Builds ship as Velopack-style `.nupkg` deltas with Windows and Linux AppImage variants; there is no macOS asset. — [Sidekick releases](https://github.com/Sidekick-Poe/Sidekick/releases)

**PoE Overlay: original (Kyusung4698) and Community Fork**
- The original became an Overwolf app ("Built with Overwolf and Angular"), installed from the Overwolf Store. Features were market search, price evaluation, map insights and game-event replay. The last release was v1.0.10 on 2020-08-02. — [Kyusung4698/PoE-Overlay](https://github.com/Kyusung4698/PoE-Overlay)
- The Community Fork "was forked on 2020-06-10 to snapshot the app before it was converted to utilizing Overwolf". Features:
  - price evaluation against the official trade site, with a price-distribution graph
  - a stash grid overlay
  - a Trade Companion for whispers ("Inspired by MercuryTrade"), with invite, trade and whisper buttons
  - vendor recipe tracking ("Inspired by ChaosRecipeEnhancer")
  - hotkey commands

  It supports Windows 10/7 x64 and Linux x64. — [Community Fork](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork)
- v0.9.0 (2026-09-01) is a major dependency upgrade: Electron 8.3.1 → 28.3.3, Angular 9 → 17, iohook → uiohook-napi. It updates assets for PoE client v3.29.3. The latest release has only ~463 installer downloads. — [Community Fork v0.9.0](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork/releases/tag/v0.9.0)

**POE-TradeMacro (legacy AHK)**
- An AutoHotkey v1 script built on PoE-ItemInfo. The README still describes searching **poe.trade** (alt+d) and poeapp.com, and requires AHK 1.1 (not v2). It works only with an English client. — [POE-TradeMacro README](https://github.com/PoE-TradeMacro/POE-TradeMacro)
- The last release was v2.16.0 (2020-06-19) and the last commit was 2021-08-02. The repo is not formally archived, and its website carries no discontinuation notice. — [POE-TradeMacro releases](https://github.com/PoE-TradeMacro/POE-TradeMacro/releases), [poe-trademacro.github.io](https://poe-trademacro.github.io/)

**Xiletrade**
- "POE Overlay, Price Checker and Helper tool for Path Of Exile 1 and 2". It is a standalone .NET desktop app, with the WPF UI under GPLv3, and ships a Windows x64 .7z. — [Xiletrade repo](https://github.com/maxensas/xiletrade)
- 1.15.10 (2026-08-22) adds Heist contract/blueprint and Mercenary Warrant checks, Scrying Orb map variants, and Korean IME support. It also adds KR/JP/RU regex links and rate-limit handling. — [Xiletrade release](https://github.com/maxensas/xiletrade/releases/latest)

**Other small or new projects (all under 10 stars)**
- jdoss/poechk: a "price-check overlay for the COSMIC desktop" (Linux), pushed 2026-08. — [GitHub](https://github.com/jdoss/poechk)
- JIRPOS/PathOfPriceCheck: a native C++/SDL price checker for Windows and Linux, pushed 2026-08. — [GitHub](https://github.com/JIRPOS/PathOfPriceCheck)
- alueck/POE-TradeHelper: pushed 2026-08. — [GitHub](https://github.com/alueck/POE-TradeHelper)

**Popularity signals (latest-release installer downloads, GitHub, 2026-09-23)**
- APT v3.29.108 `Setup.exe`: 154,559. `latest.yml`, which is fetched by auto-updaters, shows 325,225 hits. — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- EE2 v0.16.3 `Setup.exe`: 201,114. `latest.yml`: 651,100. — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- Sidekick v2026.9.2 `windows-x64-Setup.exe`: 3,529 and full `.nupkg`: 3,692. `releases.windows-x64.json`, the update-check feed, shows 79,536 hits. — [Sidekick releases](https://github.com/Sidekick-Poe/Sidekick/releases)
- Summed all-time asset downloads, inflated by updater files: APT ≈59.0M, Sidekick ≈48.0M, PoE Overlay Community Fork ≈32.7M, EE2 ≈27.8M. — GitHub API

### Inferences
- APT (PoE 1) and EE2 (PoE 2) are clearly the most-used tools, by both stars and installer downloads. EE2's latest release has more installer downloads than APT's, which suggests PoE 2's active player base currently equals or exceeds PoE 1's in this tool category. It could also reflect release timing: EE2 v0.16.3 has been out slightly longer than APT's latest.
- Sidekick is the only mature single app that covers both games. By download signals, its active install base looks roughly an order of magnitude smaller than APT or EE2, but the difference in update mechanisms makes a direct comparison unreliable.
- In effect, the APT codebase is the standard for both games: EE2 is a fork that pulls APT fixes. For example, EE2 v0.15.8 notes "Pull in possible linux fix from APT".
- Console: all of these tools depend on PC clipboard parsing (Ctrl+C item text) and a desktop overlay, so none apply to console realms.

### Gaps
- No Reddit or official-forum threads with usage polls were retrievable. Web search did not surface r/pathofexile or r/PathOfExile2 discussion pages.
- There is no reliable active-user count for any tool, and download numbers are distorted by updaters.
- The exact date poe.trade shut down, which effectively broke POE-TradeMacro, was not verified in this session.
- Sidekick's full feature list (map-check details, chat commands, stash features) was not fetched from sidekick-poe.github.io. Beyond its README tagline, only release-note mentions were verified.

## Feature comparison (price check, bulk/currency, map check, filters, pseudo mods, whisper helpers, stash search)

### Takeaway
APT, EE2, Sidekick and Xiletrade all provide a clipboard-driven overlay with price checks against the official trade API, selectable stat filters and pseudo mods, poe.ninja/poeprices integration, and map/item modifier checks. Whisper/trade-notification management lives in the PoE Overlay Community Fork, Poe Lurker and MercuryTrade, not in APT.

### Cited Findings
- APT:
  - Price check with selectable stat filters, plus pseudo stats ("You should now see much less stats consumed by conversion into pseudo stats", v3.29.108)
  - Item/Map check with PoEDB links and a Maven Witness reminder
  - "Merchant Only" filter default settings
  - Wiki hotkey, widget overlay (Shift+Space) and stash-tab scrolling
  - poeprices.info (rare price prediction) and poe.ninja integration

  — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases), [APT Quick Start](https://snosme.github.io/awakened-poe-trade/quick-start)
- EE2: everything inherited from APT, plus the PoE 2 Item Editor (augment/catalyst what-if pricing), regex helper links, poe2db mod-page links (v0.12.7) and poe2filter.com links (v0.11.x). — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- Sidekick:
  - Price check and "dangerous map modifiers" check
  - Wiki hotkeys (added for PoE 2 in 2024-12)
  - Pseudo modifiers (refactored 2025-01; the note then read "still not available in PoE2")
  - poe.ninja and poe2scout prices with a graph
  - Socket colour filters (v2026.9.1)

  — [Sidekick repo](https://github.com/Sidekick-Poe/Sidekick), [Sidekick releases](https://github.com/Sidekick-Poe/Sidekick/releases)
- PoE Overlay Community Fork:
  - Price evaluation with a distribution graph and an in-game browser
  - Stash grid overlay and vendor recipe tracker
  - Trade Companion for incoming/outgoing trade and bulk-exchange whispers (added in v0.8.0-BETA, 2021-04)
  - poe.ninja exchange rates

  — [Community Fork README](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork), [releases](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork/releases)
- Poe Lurker: "a simple yet very powerful trade manager", with Patreon-gated "Lurker Pro" features. — [Poe-Lurker README](https://github.com/C1rdec/Poe-Lurker)
- POE-TradeMacro (historical): alt+d price check, alt+shift+d advanced mod-select search, alt+w wiki, alt+e item age, and alt+r premium-tab currency-ratio note. — [POE-TradeMacro README](https://github.com/PoE-TradeMacro/POE-TradeMacro)

### Inferences
- APT and its fork have no built-in whisper helper. Players who want trade-notification UIs pair APT with a separate tool, or rely on in-game async trade instead (see next section).

### Gaps
- A granular per-tool feature matrix (e.g. stash-search highlight regex in APT, heist support in Sidekick) was not verified line by line.

## How did the landscape change after the PoE 1 3.25 Currency Exchange (Faustus), 3.27 async trade and PoE 2's release?

### Takeaway
None of the tools can read Faustus order books directly. GGG exposes only an hourly-aggregated Currency Exchange API, which poe.ninja consumes. Tools therefore adopted **poe.ninja exchange-derived ratios** instead: EE2 from Sep 2025, Sidekick from Sep–Nov 2025, APT from Dec 2025 and the PoE Overlay Community Fork from Mar 2026. After 3.27 (async Merchant tabs, Nov 2025), APT went further. It **removed bulk-trade lookups** and made "Merchant Only" the default search, which caused user backlash.

### Cited Findings
- The Currency Exchange with Faustus launched in 3.25 Settlers of Kalguur. Listing currency costs gold. — [Maxroll Currency Exchange guide](https://maxroll.gg/poe/currency/currency-exchange-market)
- In July 2025 an APT user asked to "Display Currency Exchange Prices (Faustus)". The reply was: "this data is not available via API or trade site so unless someone wants to constantly record data from Faustus in game this will remain impossible." — [APT issue #1628](https://github.com/SnosMe/awakened-poe-trade/issues/1628)
- 3.27 Keepers of the Flame (late Oct 2025) introduced asynchronous trade: Faustus sells items from Merchant tabs while the seller is offline, and premium tabs convert to Merchant tabs for free. — [PoE Vault trade guide (updated 2026-03-06)](https://www.poe-vault.com/guides/how-to-trade-in-path-of-exile), [Mobalytics merchant tabs guide](https://mobalytics.gg/poe/guides/merchant-tabs-and-async-trading-with-faustus)
- APT v3.27.101 (2025-11-01) "Added support for Merchant listings". v3.27.103 (2025-11-07) made search use "Merchant Only" by default, and its release notes say "bulk trade was removed". — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- SnosMe explained the removal in an issue thread: "GGG doesn't provide api for currency exchange, and the bulk trade is dead … all first 20 listings are pricefixers." He also said "stash listing account for 1% and they are usually on top, which are in most cases pricefixers … stash tabs are dead", and "GGG disallows to place any item in Merchant that is available on Currency Exchange."
  - Users pushed back, especially HC/private-league players who still rely on bulk exchange. SnosMe then said "poe.ninja promised to switch to exchange prices. I'll revert this change, however you will need to press a 'Search anyway' button", and "Divcards will be back tho."
  - A commenter cited poe.ninja's `https://poe.ninja/poe1/api/economy/exchange` endpoint, which lags about 1h.

  — [APT issue #1694](https://github.com/SnosMe/awakened-poe-trade/issues/1694), [APT issue #1692](https://github.com/SnosMe/awakened-poe-trade/issues/1692)
- APT v3.27.106 (2025-12-09): "price checking currency items now shows their Market Ratio on Currency Market Exchange (via poe.ninja)". — [APT releases](https://github.com/SnosMe/awakened-poe-trade/releases)
- EE2 v0.12.3/0.12.4 (Sep 2025): "With access to currency exchange prices, thanks to https://poe.ninja, all listings not in exalts, or divines, now show their stable currency equivalent price". — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- Sidekick changes:
  - v2025.909.1836 (2025-09-09): "Improved Poe2Scout integration with the new official currency exchange APIs"
  - v2025.1107.1455 (2025-11-07): "Removed automatically search for currency setting. The currency exchange data is more accurate."
  - v2026.8.5: fixed a poe.ninja currency exchange display bug
  - v2026.9.1 (2026-09-05): "Removed trade feature for currency exchange items"

  — [Sidekick releases](https://github.com/Sidekick-Poe/Sidekick/releases)
- PoE Overlay Community Fork v0.8.40 (2026-03-13) "Added the option (default on) to use the currency exchange data (instead of stash data) when obtaining exchange rates". v0.8.41 added stash-grid overlays for specialized tabs that show exchange rates. — [Community Fork releases](https://github.com/PoE-Overlay-Community/PoE-Overlay-Community-Fork/releases)
- GGG's public Currency Exchange endpoint is `GET https://web.poecdn.com/api/currency-exchange/<realm>/<id>`, where the id is a unix timestamp truncated to the hour. It is paged via `next_change_id` and tied to the `service:cxapi` scope. — web search summary of GGG developer docs (secondary; not fetched directly this session)
- PoE 2 release (EA Dec 2024):
  - Sidekick added PoE 2 support on 2024-12-14.
  - EE2 was created as an APT fork specifically for PoE 2.
  - APT itself remains PoE 1-only.
  - PoE 2 got async trade in 0.3.

  — [Sidekick release](https://github.com/Sidekick-Poe/Sidekick/releases/tag/v2024.12.14.1731), [EE2 repo](https://github.com/Kvan7/Exiled-Exchange-2), [Sportskeeda on PoE2 0.3 async trade](https://www.sportskeeda.com/mmo/path-exile-2-poe2-auto-trade-0-3)

### Inferences
- The currency-exchange era moved tools away from trade-site bulk listings as the price source for fungibles. poe.ninja's aggregation of GGG's hourly exchange API became the canonical input, so ratios are about 1h stale and there is no live order-book depth.
- Both lead maintainers now treat stash/bulk listings for exchange-eligible items as unreliable because of pricefixing. Sidekick's Sep 2026 removal of trade search for exchange items mirrors APT's Nov 2025 change.

### Gaps
- It is unconfirmed whether APT fully restored the bulk "Search anyway" path in a later release; the release notes do not mention it explicitly.
- The GGG developer-docs page for the Currency Exchange API was not fetched directly, so the endpoint details come from a search-engine summary.

## Which tool is the community standard, and why?

### Takeaway
For PoE 1 the de facto standard is **Awakened PoE Trade**. For PoE 2 it is **Exiled Exchange 2**. They lead on stars, downloads and release cadence, update on each league launch, and are free, MIT-licensed and cross-platform. Sidekick is the main alternative, preferred by users who want one .NET app for both games.

### Cited Findings
- APT has the most GitHub stars (2,583) and forks (761) of any tool in this category. It has shipped releases in every league from 3.25 through 3.29, and its latest release was 2026-09-09. — [APT repo](https://github.com/SnosMe/awakened-poe-trade)
- EE2 (1,182 stars) has the highest per-release installer download count observed (201,114 for v0.16.3). — [EE2 releases](https://github.com/Kvan7/Exiled-Exchange-2/releases)
- A 2026 u4gm guide is titled "Mastering Awakened PoE Trade in Path of Exile: A 2026 Guide". Several PoE 2 guides (MMOJUGG, poe2pricecheck.com) center on EE2 as the overlay of choice. These are RMT/SEO-oriented sites and low-authority sources. — [u4gm](https://www.u4gm.com/poe/blog-mastering-awakened-poe-trade-in-path-of-exile-a-2026-guide-for-smarter-trading), [MMOJUGG EE2 guide](https://www.mmojugg.com/news/poe2-price-checker-exiled-exchange-2-beginner-guide.html), [poe2pricecheck.com comparison](https://www.poe2pricecheck.com/guide/tools/). The poe2pricecheck.com page recommends its own web tool as the "primary reference", so it is self-promotional.
- Sidekick credits both APT and POE-TradeMacro, which acknowledges the lineage. — [Sidekick repo](https://github.com/Sidekick-Poe/Sidekick)

### Inferences
- APT and EE2 hold "standard" status because they are fast to update after patches (data updates within days of league launch), work with the official trade API with CAPTCHA and rate-limit handling, support Windows, Linux and macOS, and share one codebase and UX across games.

### Gaps
- No primary community source was found this session that explicitly calls APT or EE2 "the standard", such as a GGG staff mention, a Reddit megathread or a poll. The standard-status conclusion is inferred from GitHub metrics.
