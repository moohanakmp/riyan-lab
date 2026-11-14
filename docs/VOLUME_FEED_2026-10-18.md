# Volume and candle-history repair — staging

## Cause

Spot-price requests succeeded independently of candle-history requests. Metal OHLC/volume still depended on Binance, which returned unavailable/restricted responses from staging. BTC had already moved to Coinbase. Dashboard, Signals, Low Profit, Flow and Research were not all using the same recovery paths.

## Changes

- Keep the existing live derivatives sources and BTC Coinbase behavior. Add a bounded, authenticated Yahoo chart proxy and shared reference adapter for COMEX gold/silver, NYMEX platinum/palladium, and seven CME major currency futures.
- Restore historical volume and OHLC analysis when the live metal history source fails. Low Profit history/replay, Flow and Research use the same fallback. The forex/platinum/palladium selector in Flow is reference analysis only; it does not add execution instruments.
- Keep exchange volume as contracts. Forex futures with opposite quotation direction (JPY, CAD, CHF) invert open/close and swap inverse high/low. Do not call this broker tick volume or consolidated spot volume.
- Mark delayed futures as analysis-only throughout aggregation. Never rescale these candles to a spot quote, append live spot ticks to them, open auto/manual/scalp/basket entries from them, settle existing paper positions from their OHLC, or grade spot-gold actual outcomes from them. Existing live-quote position management remains unchanged.
- Show source, age and reference/unavailable status consistently across tabs. Preserve source labels on research results. Suppress live reversal alerts from reference history.
- Reject malformed data, omit null closed-market slots and off-grid session fragments, and require complete source buckets for aggregated candles. Missing volume stays unknown, not fabricated. Cache/coalesce requests and back off unavailable live sources.
- Retain existing position sizes, risk gates, auth, accounting rules and database migrations. Version changed browser modules/service-worker cache.
- Fix a pre-existing clock-dependent regression fixture: its supposedly one-day sample could cross IST midnight depending on when CI ran. Anchor the fixture to IST midnight and explicitly test the next-day limit reset.

## Verification

- All six Node checks: frontend/static references, sync/scalp, basket, trading, BTC feed and new reference-feed regressions.
- Maven `verify` locally with Java 17 compatibility override: 9 unit tests passed; 8 PostgreSQL integration tests require CI. Project/Docker/CI target remains Java 21.
- Direct provider inspection returned nonzero 15-minute volume for all eleven reference instruments. Gold 1m/5m/daily and gold/silver hourly requests returned history. A gold hourly response normalized to 5,689 hourly and 1,232 complete 4h bars; special holiday half-hour session starts are omitted rather than rounded into the wrong bucket.
- Public-provider availability is not guaranteed. A later request returned HTTP 429; this must remain visible and must never be replaced with invented candles. A subsequent request using the application's documented request header succeeded.
- Staging diagnostics now includes authenticated history/volume checks for all reference instruments. This does not place trades or create test records.

## Remaining limitations

The fallback is delayed futures history, not a real-time broker feed. It restores reference volume/analysis; it cannot restore real-time metal trade eligibility while the original live provider is unavailable. A supported real-time spot/broker source is still required for that. Futures rollovers and delayed data also limit interpretation of historical research/replays.

The trading UI still executes paper scenarios for its original three assets only. Forex coverage here means reference volume analysis for EUR/USD, GBP/USD, AUD/USD, NZD/USD, USD/JPY, USD/CAD and USD/CHF, not every exotic currency pair. No database credentials or schema changes are needed for this repair.

Passing tests is evidence against the covered regressions, not a guarantee that the entire application is bug-free or profitable. Authenticated deployed flows must also be verified after deployment.
