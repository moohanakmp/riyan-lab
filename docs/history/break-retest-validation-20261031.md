# Paper scalping break and first retest experiment

Adds an alternative 5m structure setup to the existing paper Low Profit scanner and shared background runtime. Auto's 15m trend strategy is unchanged.

A 20-bar range must break with a directional body of at least 0.4 ATR and volume of at least 1.2 times the preceding average. Within eight candles, the first retest must hold the broken level and close directionally, near the level, with volume at least 0.8 times average. Prior retests, invalidation, missing volume, stale/reference candles, gaps and a strong opposing 15m trend reject the setup. The existing structural stop, configured loss cap, spread, minimum reward/risk, ownership, duplicate-entry and daily risk checks still apply.

These are candidate strategy rules, not calibrated performance claims. No thresholds were changed in the existing strategies.

## Validation

All scripts/check-*.cjs checks passed. Added mirrored BUY/SELL fixtures, immediate retests, rejection of invalidated/repeated retests, weak breakout/trigger volume, missing bars, stale/forming/reference candles, strong opposing trend and excessive structural risk. The new check is included in CI.

Replayed 30 October 2026 00:00–24:00 IST using actual OKX XAU-USDT-SWAP 5m candles with prior warm-up history. All 288 decision candles were covered. At every decision, only candles closed by that time were supplied. Baseline: zero risk-eligible candidates, zero simulated trades. Revised: zero risk-eligible candidates, zero simulated trades. Both original structure candidates remained rejected: insufficient net reward/risk at 04:30 IST; structural stop risk $4.18 above the $4 cap at 05:55 IST. Therefore this experiment does not demonstrate improved coverage on the tested day.

Replay uses exchange perpetual prices and reported volume, estimated spread and default $2 target/$4 maximum loss, not broker spot quotes, historical bid/ask, commission or historical news. It does not test 1m scalping or establish profitability. Do not present as a resolution of the missing-gold-signal report. No deployment performed.
