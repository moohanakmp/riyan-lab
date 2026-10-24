# Server signal scanning

The browser is no longer the only scanner. Spring runs a scheduled server cycle when the service is awake. It restores each active non-guest account's ledger, obtains the existing exclusive paper-engine lease, and runs the original JavaScript Auto Signals and enabled Low Profit strategies in a bounded Node runtime. Source functions are loaded from the same deployed index.html and trading-core.js; the browser implementation is not replaced.

## Deployment

The Docker image includes Node 22 alongside Java 21. Flyway V6 adds per-account background settings/status and a separate numeric ID sequence. Existing migrations, trade tables, record IDs and history are retained. BACKGROUND_SCANNER_ENABLED defaults to true. Set it to false for an emergency server-scanner rollback; the original browser scanner remains available. CI disables automatic real-feed scheduling and explicitly runs an isolated database integration test.

A server cycle waits 20 seconds after the preceding cycle finishes. Feed loading can increase the effective interval. Provider requests share the existing allowlist, caches, concurrency bounds and rate-limit cooldowns. Coinbase supplies BTC candles. The existing Binance metals route is retained; rejected or missing histories do not become fabricated signals. Calendar sources are fixed, cache-bounded and fail closed when unavailable or older than 30 minutes.

## Hosting requirement

Render free web services stop after 15 minutes without incoming traffic. An in-process scheduler cannot run while its host is stopped. This implementation does not install fake keep-alive traffic or claim continuous service on that plan. Use an always-on Render service or another genuinely always-on Java/Node host for uninterrupted background operation. No billing or hosting plan was changed.

## Ownership and safety

An active browser retains its normal lease. After it stops renewing (40 seconds), the server can claim ownership. A returning browser can preempt a server owner and restores the authoritative database ledger before generating new entries. All writes use the same transactional RecordController/PaperTradingService validation, account advisory locks, durable signal keys and audit records. Concurrent or stale owners cannot write. New entries remain paper-only, 0.01 lot, at most five simultaneous positions, with existing $4 account risk and $8 daily-loss safeguards. No broker orders are issued.

Low Profit settings are synchronized from the browser with account ownership and CSRF checks. Existing saved diagnostics seed the configuration until the first synchronization. Until the account has synchronized its complete settings once, the server manages existing positions but does not create new entries; it must not guess personal risk/goal settings. The user can pause background scanning without disabling the browser engine. Basket mode blocks new baseline scalp entries; the existing basket simulation remains browser managed. Background device push and email delivery are not implemented. Telegram entry delivery uses the server queue described below.

Signals and Settings show the last server check, current owner and per-instrument wait reasons. A heartbeat means a scan ran; it does not mean an entry qualified. Background entries and updates appear through the existing database restoration when the app is reopened.

## Validation

- Ten Node suites, including actual indicator-generated background entries, no-data/stale gates, partial target fills, adverse gaps and restart inputs.
- Java feed normalization and calendar/cache/rate-limit tests.
- PostgreSQL integration: closed-browser settlement and audit, exclusive browser/server leases, returning-browser takeover, and rejection of a stale writer.
- No synthetic quotes, fabricated trades or test users are inserted into staging by diagnostic tests.

## Optional free-tier wake-up workflow

`ops/background-wake.yml` is a prepared, inactive proposal. Copy it to `.github/workflows/background-wake.yml` on the default branch (`main`) to run a public health request every five minutes. It requires no credentials, checkout, API mutation, or order endpoint. GitHub can delay or drop scheduled jobs, so this is best-effort and not an always-on trading guarantee. It is deliberately not activated because the user requested implementation changes remain on `staging/backend-auth-20261016`; activation needs the explicit default-branch exception. No production application files need to be merged.

## Calendar outage policy

Calendar availability is advisory for Auto, Manual and Low Profit technical signals in both browser and server engines. An unavailable, stale or invalid schedule is displayed as unchecked news risk, never as a clear news window. Eligible technical setups can enter without it; known high-impact USD events still block Auto entries from 30 minutes before until 15 minutes after release, and Low Profit from 10 minutes before until 15 minutes after. Provider caching, validation and rate-limit backoff continue unchanged. Each new Auto or Low Profit record includes `newsProtection` (`CHECKED` or `UNAVAILABLE`) for audit. Fresh prices/candles, technical triggers, structural stops, spread checks, engine ownership, and account limits remain required.

## Telegram entry delivery

V10 adds private per-account Telegram settings and a durable entry outbox. Existing enabled sender settings synchronize at login; Settings saves and the Telegram test use authenticated, CSRF-protected endpoints. Status responses never expose bot tokens. The worker checks accepted Auto, Manual and Low Profit tables every 15 seconds, so browser UI failures and closed-browser scans use the same entry-delivery path. Browser entry Telegram calls are removed to avoid a second sender. Other browser notification types retain their original path.

Only records with accountingVersion 2 are considered. New entries since enablement and still-open entries created in the previous 24 hours qualify; the initial enablement does not replay closed historical trades. Messages include original IST trigger time, signal ID, entry, ladder, SL and lot, and clearly identify a paper notification. The worker sends the accepted payload snapshot, rather than recalculate a setup. This is not a fresh recommendation for an old entry.

A unique account/type/source key prevents re-enqueueing; a durable claim coordinates workers and survives restarts. HTTP status, Telegram `ok`, and message ID must confirm success. Failures retry up to five times using bounded backoff and Telegram retry_after; settings display sent, pending and failed counts with the provider error. Retry failed alerts explicitly requeues failures from the last 24 hours. An ambiguous timeout after Telegram accepts a message may still produce a duplicate on retry; Telegram sendMessage does not provide an idempotency key. The server must be running to process its queue; a sleeping free service cannot deliver while stopped. Tokens are stored in the private settings table and are not included in diagnostics or audit payloads.
