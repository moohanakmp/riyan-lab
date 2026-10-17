# Trading reliability fixes — review and release status

Prepared for `moohanakmp/riyan-lab`, branch `staging/backend-auth-20261016`, based on staging commit `a6a94814dcf2d7d0cc84c1420fe1f103e7e8b315`.

**Published to staging; live verification in progress.** The user explicitly approved pushing to the existing staging branch. The earlier publication block is superseded by that approval. No production database, broker account, or trading settings were changed during this implementation.

## Changes

| Area | Corrected behavior |
|---|---|
| Paper exits | Partial fill quantities, prices, costs and net profit are recorded together. An adverse stop gap fills at the observed price. A zero result is BE, not WIN. |
| Server accounting | New paper records require accounting version 2. Exit/profit mismatches, inconsistent fill quantities, rewritten fills, stale updates, changed entry plans and reopened closed trades are rejected. |
| Duplicate entries | A PostgreSQL lease chooses one engine browser per user. A durable signal key prevents repeat entries for the same strategy, symbol, closed candle and direction. |
| Account risk | New entries use 0.01 paper lot. Server checks five positions maximum, $4 aggregate planned stop risk including estimated spread, and an $8 daily loss limit. Gaps can exceed these planned amounts. |
| Stops | Structural stops are not clipped inward to make a position fit. A setup that cannot fit its risk cap is skipped. |
| Candles | Invalid OHLC, future timestamps, duplicates and incomplete aggregation are rejected. Tick samples do not substitute for verified historical candles. |
| Quote/news gates | Quotes older than 30 seconds since receipt, unavailable feeds and a stale/unavailable calendar pause new entries. This is not a guarantee of the upstream quote's actual market age. |
| Data transport | Authenticated, allowlisted, bounded public-data requests use a same-origin server endpoint with timeout and short caching. Provider bans and rate limits remain unavailable responses. No order endpoints are exposed. |
| Replay | Entries use the next candle open. Daily stop/goal, cooldown, adverse opening gaps, ambiguous candle ordering and final-sample handling are modeled. |
| Recovery | Accepted basket positions can reconstruct a session after a lost response. Server state wins over stale cached updates; conflicting client payloads remain in local conflict history. |
| Reporting | Auto, Low Profit and Basket appear in combined paper P&L, with strategy breakdown and IST exit-date filters. Missing results are not classified as wins or breakeven. Legacy accounting remains visibly unverified. |
| News statistics | Headline matches count one release-time group and exclude calls first recorded retrospectively. |
| UI | Session restoration has a loading state. Signals explain engine ownership/paused status and identify paper-only execution. Model scores are not described as win probabilities. |

Migration V5 adds lease and deduplication tables. V1–V4 were not edited; the V3 checksum regression passes. Trading records are read and written within their creator's account scope. Existing records are retained.

## Validation completed locally

- `node scripts/check-frontend.cjs` — passed, both HTML pages parse.
- `node scripts/check-sync-scalp.cjs` — passed.
- `node scripts/check-basket.cjs` — passed.
- `node scripts/check-trading.cjs` — passed: BUY/SELL partials and gaps, costs, duplicate closes, malformed/incomplete candles, next-open replay, daily loss/goal and freshness/lease gates.
- Maven compilation and unit tests with the available Java 17 compatibility override (`-Djava.version=17`) — passed: **7 tests, 0 failures**. The project target remains Java 21.
- **8 PostgreSQL integration tests were skipped**, including the new concurrent-entry and engine-takeover tests. The local environment only maps root and does not permit creating the unprivileged process PostgreSQL requires. The existing GitHub workflow provisions PostgreSQL 17 and Java 21 and enables these tests.
- `git diff --check` — passed.

## Staging verification — 17 October 2026

- Published commit `f036eb8020d38041a287afcfca95519f8248ab3b` directly to the requested staging branch.
- GitHub Actions run `38995660944`: Java 21 / PostgreSQL 17, **15 tests passed, zero failures or skips**; all four frontend regression scripts passed.
- Render health returned HTTP 200 and UP. The deployed index, trading-core and paper-engine files matched the published source byte for byte.
- Authenticated reload, Signals, Low Profit and combined P&L rendered. Feed history was unavailable, so signals remained WAIT. Live paper-entry/exit scenarios cannot be certified without a usable candle feed.
- Follow-up from live testing: version application modules to avoid mixing old and new scripts during rollout; correct fixed-lot, stop-gap, session and freshness labels. Engine restoration remains under investigation.

## Remaining release gates

1. Push the reviewed fixes directly to `staging/backend-auth-20261016`, as explicitly requested.
2. Require the Java 21/PostgreSQL integration workflow and all frontend checks to pass; fix any failures before merging.
3. Verify the staging deployment, V5 and application health. Production/main is outside this release.
4. Re-test authenticated reload, all trading views, owner/follower browsers, fresh/stale feed behavior, paper entry/partial/exit, complete P&L, replay and DB restoration against staging.
5. Verify provider access from Render. Availability from Render and broker execution have not been established by local tests.

## Practical limits

This remains a browser-operated paper application. The active engine browser must stay open; a suspended browser cannot provide continuous execution. There is no MT5 order routing in this repository. XAU/XAG/BTC contract multipliers and spreads are paper assumptions, not verified broker specifications. Replays omit historical news, commission, financing, real slippage and combined multi-asset overlap. Existing historical P&L cannot be certified or repaired accurately without the missing original fill evidence. None of these tests establishes profitability or a bug-free application.
