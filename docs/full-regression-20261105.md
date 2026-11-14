# Full application regression bundle — 5 November 2026

## Scope and release basis

Working branch: `staging/backend-auth-20261016`, based on `97ebc8cb6ef2da65fa4a1a8e3eb835eaf8d21d12`. The user authorized a full application test and fixes together. The existing authenticated cloud-browser administrator session was reused. No account/password/role changes, test notifications, broker orders, forced signals, risk-limit increases or production/main deployment were performed.

## Reproduced defects addressed

| Area | Defect | Result |
|---|---|---|
| Startup | Optional third-party email SDK blocked HTML parsing and therefore sign-in initialization | SDK loads asynchronously; its existing availability guards and send-time initialization remain intact |
| Navigation | Role UI selected the first tab on refresh; the presentation adapter could consume the requested route before authentication initialization completed | Restore only a permitted route or current tab; routing waits while the app is hidden |
| Dashboard | A technical tier appeared as a ready BUY/SELL setup even when actual entry approval rejected structural risk | Reuse `computeSignal` and `autoEntryCheck`; show the blocker, or label a candidate as awaiting acceptance |
| News | Stored server RSS was attempted only after six slow external failures; failed results could remain cached for the full success TTL | Use validated stored RSS first, retain external fallback, retry empty/failed results after 30 seconds, and show loading immediately |
| Feed refresh | A failed BTC timeframe discarded healthy sibling results; metals similarly discarded a successful higher timeframe, and local retry backoff crossed timeframe boundaries | Retain successful frames independently and scope local request backoff by instrument/timeframe; shared provider rate-limit cooldowns remain enforced |
| News rendering | Headline/source strings were interpolated as HTML | Escape text; stored-news mapping rejects invalid URLs, ancient dates and future dates |
| MTF analysis | Short-timeframe strip used only locally collected ticks despite already loaded provider history; forming bars could influence the strip | Prefer fresh closed provider candles, including the shared minute cache and Low Profit 5m history, with closed tick-derived candles as fallback |
| Analytics | Slow response for a previous asset could overwrite the newly selected asset | Request generation and symbol checks discard obsolete completions |
| History | Restored records could display out of chronological order; BE appeared OPEN; floating P&L ignored spread and partial remaining quantity | Sort display copies by entry time, label BE explicitly, reuse the existing fresh-quote floating-P&L helper, tolerate missing percentage metadata |
| Recent scalps | Array insertion order could hide newer closes | Sort by exit time before taking the latest 15, without mutating the ledger |
| P&L dates | Custom defaults used UTC dates; month labels could add the local timezone twice | Compute explicit IST date defaults and format the already shifted month in UTC |
| Research | A provider exception for one asset aborted research for the remaining assets | Isolate per-asset errors and restore the control after completion |
| Research/replay labels | Last daily close was labelled Current; indicator-only replay counts could be mistaken for accepted live entries | Label daily-close scenarios and their timestamp; state the replay's actual exclusions |
| Guide | Legacy six-check logic, 15-minute Auto cooldown, old news routing and unverified automatic reports were described as current behavior | Explain the existing v3/Low Profit rules, real polling/cooldowns, persistence and report-delivery boundary |

No signal thresholds, dollar-risk caps, position sizes, accepted-trade lifecycle, database schema or Telegram delivery implementation were changed by this bundle. MTF trend warnings now consistently read closed candles; those warnings do not independently open or close trades.

## Live acceptance coverage before this bundle

All 16 workspace destinations were opened: Markets, Prices, Signals, Low Profit, History, Analysis, Session, Volume Trap, Flow, Manual, Research, Analytics, P&L, Admin and Info. The existing staged fixes were already live. Browser session restoration, record restore and pending queue recovery were observed; the sync indicator reached DB Synced.

- Manual analysis completed for all three assets and kept rejected plans separate from accepted trades. A gold quality score of 73 coexisted with a structural-risk rejection of about $11 at 0.01 lot, demonstrating why technical quality alone is insufficient.
- Flow Analyze completed for all three assets using OKX metal history and Coinbase BTC history. Its sample limitations remained visible.
- Research completed for all three assets and displayed real sample counts and daily-close scenarios. This exposed the misleading Current label corrected above.
- Volume Trap 1m history loaded from OKX for gold and from Coinbase for BTC; 5m switch and detailed timestamped volume rows worked. Silver's minute request was initiated, with post-release verification planned alongside the other assets.
- Analytics replay completed on the loaded approximately 5.2 days of history. Those are indicator-only results, not an account-risk-eligible entry count, and are now labelled accordingly.
- History, active-only Signals, P&L periods, admin delivery status and source/permission controls were inspected. Destructive archive/reset/user-management actions were not exercised against the user's records; isolated backend integration tests cover account permissions and persistence.
- Prior authenticated endpoint audit: 40 passes, 16 provider warnings, zero failures. Primary quote, Coinbase and OKX candle routes passed. The warnings cover FF calendar HTTP 429, legacy Binance denial and unavailable delayed-reference history. These external provider limitations are not represented as resolved by UI changes.
- Prior server takeover test changed ownership from browser to server and produced a fresh three-asset scanner cycle with no quote/frame errors; returning to the browser restored ownership. No eligible entry occurred during that live observation.

## Automated regression coverage

New `scripts/check-app-regression.cjs` runs in CI with the existing suite. It covers server-first RSS and fallback, malformed/old headlines, permitted/forbidden/malformed routes, obsolete Analytics completions, provider 5m MTF history and stale history, dashboard risk approval, history time ordering, breakeven and partial/stale floating P&L, IST month boundaries, research failure isolation, independent BTC/metal timeframe refresh and backoff, and nonblocking optional SDK loading. It passes with `TZ=Asia/Kolkata` as well as the default timezone.

The pre-change news fixture reproduced all six external attempts before stored RSS, and the route fixture reproduced reset to the first tab. Existing positive-entry, stale-data, dollar-risk, daily-budget, duplicate, ownership, paper-lifecycle, sync and Telegram regressions remain required. Local JavaScript checks passed during development; final CI must also pass the Java/PostgreSQL integration suite before the release is reported verified.

## Signal-quality boundary

Software correctness is not evidence of a profitable or sufficiently frequent strategy. The preceding Low Profit proxy replay produced zero accepted trades with default $2 target/$4 cap, and this bundle intentionally does not weaken that approval boundary. Current setup absence, real structural risk and unavailable third-party feeds remain distinguishable from a software fault. No zero-regression or profitable-entry guarantee is established by this report.
