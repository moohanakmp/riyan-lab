# Signal audit — 5 November 2026

## Outcome and limits

The missing-signal complaint is not resolved by passing the existing checks. The deployed commit and authenticated account diagnostics still need verification. Staging `/api/v1/health` returned `{"status":"UP"}`; no authenticated browser flow, Telegram delivery, broker execution, or production database inspection was completed.

## Reproduced defects fixed

Low Profit previously selected support/resistance before order blocks before break/retest, without comparing their executable plans. A confirmed first setup with excessive structural risk or insufficient reward masked a later confirmed, risk-eligible setup. `scalpScan` now preserves that priority among plans passing the unchanged risk checks, using the intended entry and current configuration. Browser, background and replay use this selection. When all candidates fail, entry remains blocked. Candidate rejection evidence is retained in accepted trade conditions.

The plan rejection message also incorrectly blamed an opposing level when the configured dollar target itself was too small. Diagnostics now distinguish target-limited reward from an opposing barrier and show dollar risk/reward. Stops, minimum 1.3 net reward/risk, fixed lot, loss caps, freshness, volume, ownership, daily budget and duplicate guards remain enforced. No settings were changed on an account.

A new regression test failed against the prior implementation and passes after the change. It covers competing setups, BUY/SELL, gold/silver/BTC contract sizes, live-entry risk, barriers, priority, all-candidate rejection and accurate target diagnostics. CI runs it with the existing checks.

## Actual-candle experiment

Fetched 900 OKX perpetual 5m records per instrument; 899 were closed. History covers 2 November 2026 10:00 UTC through 5 November 2026 12:50 UTC. Each symbol had 698 decision candles after 200 warm-up bars, with only history available at each decision. Entries use the next bar open. Baseline is branch commit `9d820e299a265dccda675e6324b3896f35ad7621`.

| Instrument | Confirmed setups | Common gates passed | Baseline trades | Revised trades |
|---|---:|---:|---:|---:|
| XAUUSD proxy | 6 | 5 | 0 | 0 |
| XAGUSD proxy | 4 | 3 | 0 | 0 |
| BTCUSD proxy | 3 | 3 | 0 | 0 |

Both runs used default $2 net target, $4 maximum loss, modeled spreads, daily limits and cooldowns. Gold had three setups with structural risk $2.25–$3.58: a $2 target cannot provide 1.3 times that risk. Other gold stops exceeded $4. Silver setups lacked sufficient room before opposing levels. Two BTC setups needed more than $4 net reward, and another was blocked by an opposing level. Common gates also blocked one gold and one silver setup.

A separate $4-target experiment produced two gold proxy trades with combined modeled P&L +$0.14; silver and BTC remained at zero. This is not profitability evidence or a recommendation to change settings. Account settings were left untouched. It demonstrates that configured target and structural risk explain some zero-trade behavior; this code fix does not demonstrate better coverage in these samples.

These are OKX perpetual prices, not broker spot/bid/ask. BTC's live application uses Coinbase. Metal history was not retrospectively calibrated to spot quotes. Replay excludes commission, slippage beyond the existing gap model and historical news. It is a per-symbol simulation, not a portfolio or live performance test.

Raw provider-response SHA-256 values:

- XAU: `c3545e56376cc83134f874d6e3d5153fc52074f6ae8e15f8945d36455d78a0a8`
- XAG: `f22ba2c31ab1634d7f71ff38726dc1f42bfbbe5c468f6489ad5117e17507d4dc`
- BTC: `62c3366fab111df3dd66f966453c20c328f7332b896bba17a9e218c6a77a3fcd`

## Validation boundary

All 21 `scripts/check-*.cjs` checks passed. Java 21 backend unit tests passed: 39 executed, 14 database integration cases skipped locally because no PostgreSQL integration environment was configured. Maven `verify` succeeded after supplying the runtime proxy and explicit Byte Buddy test agent required in this container. The GitHub workflow provisions PostgreSQL and enables those integration cases; its result must be checked separately for the final commit.

Render has no workspace selected. The connector lists `My Workspace` (`moohanakmp@gmail.com`), but confirmation is needed before inspecting services/logs or deploying. No live fix or profitable-signal claim is established by this audit.
