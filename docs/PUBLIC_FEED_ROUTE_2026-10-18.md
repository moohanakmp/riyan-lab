# Restore original browser public-market requests

The original migration (7a05c43) and the parent of f036eb8 called public exchange endpoints directly from the browser. f036eb8 moved every public request behind the authenticated Render proxy. Render staging subsequently returned provider HTTP 451 for Binance metal candles; the Yahoo reference fallback returned HTTP 429. This path change explains why device-accessible feeds can stop working after migration. It does not establish that every device/region can access the provider.

The shared liveFetch adapter now restores direct browser requests for the original bounded Binance candle endpoints only. Working Coinbase BTC quotes/history and gold-api spot quotes retain their backend route. No MT5 connector is added or required.

Public requests omit credentials and application headers. Identical concurrent requests share one fetch; short cache lifetimes and host-wide cooldowns limit retries. An explicit browser HTTP 429/451/403 is returned without rerouting. Only a failed browser transport (for example CORS/network failure) uses the existing authenticated server endpoint. No alternate hosts, VPN, credential sharing or synthetic candles are used.

All existing metal consumers already share liveFetch: main history, Low Profit, Flow, Research and replay. Existing OHLC validation, completed-candle/freshness checks, delayed-reference restrictions and risk/P&L rules remain active. Weekend market closure and insufficient setups can still legitimately pause entries.

Validation: all six existing Node regression scripts plus check-public-market-fetch.cjs. Java/PostgreSQL integration runs in CI. Staging audit shows the Render and browser market paths separately. Live provider availability must be checked from the user's actual browser; this change does not guarantee forex-reference availability or trading accuracy/profitability.
