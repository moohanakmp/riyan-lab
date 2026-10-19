# Server signal scanning

The browser is no longer the only scanner. Spring runs a scheduled server cycle when the service is awake. It restores each active non-guest account's ledger, obtains the existing exclusive paper-engine lease, and runs the original JavaScript Auto Signals and enabled Low Profit strategies in a bounded Node runtime. Source functions are loaded from the same deployed index.html and trading-core.js; the browser implementation is not replaced.

## Deployment

The Docker image includes Node 22 alongside Java 21. Flyway V6 adds per-account background settings/status and a separate numeric ID sequence. Existing migrations, trade tables, record IDs and history are retained. BACKGROUND_SCANNER_ENABLED defaults to true. Set it to false for an emergency server-scanner rollback; the original browser scanner remains available. CI disables automatic real-feed scheduling and explicitly runs an isolated database integration test.

A server cycle waits 20 seconds after the preceding cycle finishes. Feed loading can increase the effective interval. Provider requests share the existing allowlist, caches, concurrency bounds and rate-limit cooldowns. Coinbase supplies BTC candles. The existing Binance metals route is retained; rejected or missing histories do not become fabricated signals. Calendar sources are fixed, cache-bounded and fail closed when unavailable or older than 30 minutes.

## Hosting requirement

Render free web services stop after 15 minutes without incoming traffic. An in-process scheduler cannot run while its host is stopped. This implementation does not install fake keep-alive traffic or claim continuous service on that plan. Use an always-on Render service or another genuinely always-on Java/Node host for uninterrupted background operation. No billing or hosting plan was changed.

## Ownership and safety

An active browser retains its normal lease. After it stops renewing (40 seconds), the server can claim ownership. A returning browser can preempt a server owner and restores the authoritative database ledger before generating new entries. All writes use the same transactional RecordController/PaperTradingService validation, account advisory locks, durable signal keys and audit records. Concurrent or stale owners cannot write. New entries remain paper-only, 0.01 lot, at most five simultaneous positions, with existing $4 account risk and $8 daily-loss safeguards. No broker orders are issued.

Low Profit settings are synchronized from the browser with account ownership and CSRF checks. Existing saved diagnostics seed the configuration until the first synchronization. The user can pause background scanning without disabling the browser engine. Basket mode blocks new baseline scalp entries; the existing basket simulation remains browser managed. Background device push, email and Telegram delivery are not implemented; their existing browser paths are unchanged.

Signals and Settings show the last server check, current owner and per-instrument wait reasons. A heartbeat means a scan ran; it does not mean an entry qualified. Background entries and updates appear through the existing database restoration when the app is reopened.

## Validation

- Ten Node suites, including actual indicator-generated background entries, no-data/stale gates, partial target fills, adverse gaps and restart inputs.
- Java feed normalization and calendar/cache/rate-limit tests.
- PostgreSQL integration: closed-browser settlement and audit, exclusive browser/server leases, returning-browser takeover, and rejection of a stale writer.
- No synthetic quotes, fabricated trades or test users are inserted into staging by diagnostic tests.
