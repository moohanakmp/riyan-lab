# Full-app check, live Volume Trap and declutter — 13 November 2026

## Findings from the full test
- Staging on Render free sleeps after 15 idle minutes (about 12 restarts on 13 Nov). Server news polling and the background scanner stop while it sleeps; news had an 11-hour gap overnight.
- After a wake-up the server waited 45 s before its first news poll, while the browser tried six slow public fallbacks (up to about 70 s) before showing "news unavailable".
- Every browser open POSTed that device's local Low Profit settings to `/paper/background/settings`, so the last device opened decided the server strategy (observed: experimental continuation switched on at 19:33 UTC).
- On a phone each page began with about 600 px of hero art, related-page links, an "All workspaces" directory and three status boxes. "Market data: unavailable" described candle history, next to "3/3 fresh quotes".
- Volume Trap showed closed 5m candles by default; the 1m view refreshed only every 30 s.
- Logic: risk caps ($4 max loss, $8 day stop) hold in browser and server; all existing checks and 53 backend tests pass.

## Changes
- **News:** the server polls when no successful poll happened in the last 10 minutes (checked every minute, starting 5 s after boot), and a reader of `/news/latest` triggers a non-blocking refresh when headlines are old. The browser tries stored headlines, one public fallback, stored headlines again, then one more fallback (was six). Headlines show their age.
- **Settings:** `/paper/background/status` returns the saved settings. On first load for a user the browser adopts them (with the same $4/$8 caps) and sends settings only after a local change. Accounts without saved settings behave as before.
- **UI:** slim page title; related-link chips, the "All workspaces" directory, hero art and descriptions are hidden (tab bar and More menu remain). Candle-history and news-schedule notices appear only when something needs attention; the header shows the news-check state. Signals starts with a "Right now" line per asset that reuses `computeSignal`/`autoEntryCheck` (no new rules).
- **Live Volume Trap (display only):** `live-volume.js` streams OKX XAU/XAG-USDT perpetual 1m candles and trades, and Coinbase BTC-USD matches, only while Volume Trap is visible. It shows the forming 1m candle, its volume pace against the 20-minute average and real taker buy/sell share. It never reads or writes entries; setup checks and paper entries still use closed candles. Default detail timeframe is 1m with 15 s refresh.

## Verification
- `mvn -B verify` (53 tests) and every `scripts/check-*.cjs`, including new `check-live-ux.cjs` (stream parsing, taker side, display isolation, settings adoption with caps, news retry bound).
- Local browser pass of all pages for layout; market providers are unreachable from the build sandbox, so live-data behaviour must be confirmed on staging.

## Limits
- Metals volume is the OKX perpetual's, not broker spot volume. If the browser cannot open WebSockets the panel says so and the 15 s 1m refresh remains.
- Server-side scanning and news still stop while Render free sleeps unless a keep-awake schedule is approved.
