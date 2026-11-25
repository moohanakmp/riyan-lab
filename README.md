# Riyan Lab / KMR Market

Paper-trading signal app for XAUUSD, XAGUSD and BTCUSD. **Java 21 / Spring Boot 3.5 / Maven**, **Neon PostgreSQL** (Flyway), a single-page **JavaScript** frontend (`src/main/resources/static/index.html`), hosted on **Render free tier**.

## How it fits together

| Part | Where | Notes |
| --- | --- | --- |
| Strategy engine (Auto signals, Low Profit, Analysis) | `static/index.html` (inline JS) + `static/trading-core.js` | Runs in the browser. |
| Background scanner | `BackgroundScanner.java` + `background/scanner.cjs` | Runs the *same* engine in Node when no browser holds the lease. `scanner.cjs` pulls named functions/consts out of `index.html` with regex: renaming them breaks server scanning (`scripts/check-background.cjs` catches it). See `docs/background-scanner.md`. |
| Paper ledger + risk checks | `RecordController.java`, `PaperTradingService.java` | Server re-validates every paper entry. |
| Volume Trap / order flow | `OrderFlowCollector.java`, `static/order-flow.js`, `static/live-volume.js` | Display only. See `docs/history/order-flow-footprint-20261119.md`. |
| Broker mirror (MT5 EA bridge) | `BrokerMirrorService.java`, `connector/mt5/RiyanLabBridge.mq5` | Admin Broker tab. DRY_RUN by default. See `docs/broker-bridge.md`. |
| Telegram alerts | `TelegramDelivery.java` | Server-side delivery. |
| Market data proxy | `MarketDataController.java` | Fixed host/path allowlist. |

## Safety rules (do not break)

| Rule | Enforced in | Guarded by |
| --- | --- | --- |
| Live (real-money) broker trading is OFF by default | `RIYAN_BROKER_LIVE_ENABLED` (default `false`) + typed login confirmation + EA `AllowRealAccount` | `BrokerMirrorIntegrationTest` (step 5, HALT on real account) |
| Low Profit and Basket are paper-only, never mirrored to a broker | `BrokerMirrorService.MIRRORED_TYPES` | `BrokerMirrorIntegrationTest` (step 3b) |
| Low Profit has no news/calendar dependency | `scalpScan` in `index.html` | `scripts/check-sync-scalp.cjs` |
| Auto analysis, Low Profit and Volume Trap UI stay | `index.html` tabs `signals`, `analysis`, `scalp`, `flow` | `scripts/check-app-regression.cjs`, `scripts/check-volume-trap.cjs` |
| Staging never touches the production schema | `RiyanLabApplication.java` refuses `APP_ENV=staging` with schema `riyan_lab` | startup check |
| Metal quote freshness gate stays < 30 s | `static/paper-engine.js`, `BackgroundFeeds.java` | `scripts/check-quality-consistency.cjs` |
| Never commit secrets (the repo is public) | | |

## Branches and environments

| Branch | Render service | `APP_ENV` / `DB_SCHEMA` | Deploys when |
| --- | --- | --- | --- |
| `staging/backend-auth-20261016` | `riyan-lab-staging` (https://riyan-lab-staging.onrender.com) | `staging` / `riyan_lab_staging` | Render auto-deploys every push to this branch (Docker build runs the unit tests). |
| `main` | `riyan-lab` (https://riyan-lab.onrender.com) | `production` / `riyan_lab` | Render auto-deploys every push to `main`; GitHub Actions also calls `RENDER_DEPLOY_HOOK` after a green build. |

`render.yaml` describes only the staging service; the production service is configured by hand in Render. Work goes to a feature branch, then a pull request into the staging branch. CI (`.github/workflows/build-deploy.yml`) runs `mvn verify` against PostgreSQL 17 plus every `scripts/check-*.cjs` on pushes and PRs to both branches.

## Environment variables

Set in Render (never commit values). Defaults in brackets.

| Name | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL`, `DB_USER`, `DB_PASSWORD` | `application.properties` | Neon connection (JDBC URL). |
| `DB_SCHEMA` [`riyan_lab`] | Flyway, Hikari | `riyan_lab_staging` on staging. |
| `APP_ENV` [`production`] | `RiyanLabApplication`, `AuthService`, `KeepAwake` | `staging` enables the staging-only guards and keep-awake. |
| `PORT` [`8080`] | Spring | Set by Render. |
| `RIYAN_BOOTSTRAP_ADMIN_USER`, `RIYAN_BOOTSTRAP_ADMIN_PASSWORD` | `AuthService` | First admin, only when `auth_users` is empty. Remove after first login. |
| `RIYAN_BOOTSTRAP_ADMIN_RESET` [`false`] | `AuthService` | Staging only: reset the bootstrap admin password on boot. Turn off again after use. |
| `RIYAN_BROKER_LIVE_ENABLED` [`false`] | `BrokerMirrorService` | Server gate for real-money accounts. Leave off. |
| `BACKGROUND_SCANNER_ENABLED` [`true`] | `BackgroundScanner` | Server-side scanning when no browser owns the lease. |
| `ORDER_FLOW_ENABLED` [`true`], `ORDER_FLOW_BACKFILL_HOURS` [`6`] | `OrderFlowCollector` | Volume Trap footprint collector and gap-fill window (1-12 h). |
| `RENDER_EXTERNAL_URL` | `KeepAwake` | Set by Render; staging self-ping target. |
| `SCANNER_STATIC` | `background/scanner.cjs` | Optional path to the static folder (tests). |
| `RIYAN_INTEGRATION_TEST` | tests | `true` enables the PostgreSQL integration tests. |
| `RIYAN_TOKEN_KEY` [unset] | `TelegramDelivery` (`TokenCipher`) | Passphrase for AES-256-GCM encryption of Telegram bot tokens at rest. When set, plain tokens are encrypted at startup. Keep it stable: if it is removed or changed, saved tokens cannot be read and users must re-enter them. |

## Security headers

`SecurityHeadersFilter` sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS (on HTTPS) and a Content-Security-Policy. Scripts may load only from this site, `cdn.jsdelivr.net` (EmailJS, pinned with integrity) and `s3.tradingview.com`. `'unsafe-inline'` stays until the inline engine and `onclick` handlers in `index.html` move into files. Request bodies are capped at 16 KB for `/api/v1/auth/` and 2 MB elsewhere (413). Logged-in users get at most 180 upstream market-data fetches per minute (cached answers are free).

Dated audit and design notes live in `docs/history/` and may be out of date.

## Run tests locally

```bash
# PostgreSQL 17 with database neondb, user/password postgres
export DATABASE_URL=jdbc:postgresql://localhost:5432/neondb DB_SCHEMA=riyan_lab_staging APP_ENV=staging \
  DB_USER=postgres DB_PASSWORD=postgres RIYAN_BOOTSTRAP_ADMIN_USER=testadmin \
  RIYAN_BOOTSTRAP_ADMIN_PASSWORD=unit-test-password-1234 RIYAN_INTEGRATION_TEST=true \
  BACKGROUND_SCANNER_ENABLED=false ORDER_FLOW_ENABLED=false
mvn -B verify                                   # without RIYAN_INTEGRATION_TEST the DB tests are skipped silently
for f in scripts/check-*.cjs; do node "$f" || echo "FAIL $f"; done
```

Tests must not depend on today's date: inject a clock (see `OrderFlowCollector.clock`, `EconomicCalendar`).

## History

The sections below are the original migration notes, kept for context. Where they disagree with the sections above, the sections above are current.

## Stage 2: server identity, data integrity, news checks (PR #2)

**Do not merge this into a live Render application until the new administrator login is configured and validated on staging.** The previous hard-coded browser passwords and the shared `RIYAN_API_TOKEN` are no longer accepted by the API.

### Render environment variables (set in Render, never commit values)

- `DATABASE_URL`, `DB_USER`, `DB_PASSWORD`: existing Neon connection. App user needs USAGE/CREATE rights on schema `riyan_lab`.
- `RIYAN_BOOTSTRAP_ADMIN_USER`: new administrator login (3–48 letters/numbers/underscore/hyphen).
- `RIYAN_BOOTSTRAP_ADMIN_PASSWORD`: unique strong 12+ character password. **Set both before deploying PR #2.** The backend creates the first admin only if there are zero accounts in `riyan_lab.auth_users`. Afterwards manage users in the application's Admin tab. Rotate/remove the bootstrap password environment variable after verifying the new login (removing it does not delete the DB account).

Login uses a server-validated, HttpOnly session cookie and an anti-CSRF header/cookie pair. Passwords are BCrypt hashes in `auth_users`. Existing browser accounts, their plaintext passwords and old IndexedDB `currentUser` entries are deliberately not trusted. Recreate the required users from the Admin tab using new passwords.

### What is persisted

Existing V1 tables remain intact. Flyway V2 adds user/role/session tables, per-user state, backend news feed items and fetch health, and structured columns for symbol, direction, status, reason, timeframe, entry, SL, TP levels, conditions and actor. The original JSONB payload remains the source of complete detail. `audit_events` keeps before/after payloads for changed records and `user_activity` records logins, logout, user and permission actions.

Browser-generated auto/manual/low-profit signals and outcomes are queued automatically for the API; research, analysis, gold event prediction/actual, seven-day outlooks and P&L aggregates are periodically snapshotted. Retry state is kept in that browser's origin-specific localStorage until acknowledged by the server. The Admin tab has **View DB audit** and **News feed health** buttons. As a migration precaution, browser history is kept rather than deleted.

### Acceptance queries (Neon SQL Editor)

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema='riyan_lab' ORDER BY table_name;

SELECT record_type,source_id,action,actor,event_time
 FROM riyan_lab.audit_events ORDER BY id DESC LIMIT 30;

SELECT username,action,entity_type,entity_id,created_at
 FROM riyan_lab.user_activity ORDER BY id DESC LIMIT 30;

SELECT symbol,status,found_count,error_message,checked_at
 FROM riyan_lab.news_fetch_runs ORDER BY id DESC LIMIT 20;

SELECT source_id,symbol,status,reason,timeframe,entry_price,stop_loss,
 take_profit_1,take_profit_2,signal_conditions,updated_by,updated_at
 FROM riyan_lab.auto_signals ORDER BY updated_at DESC LIMIT 20;
```

### Compatibility and outstanding work

- Existing market-price/indicator/news-alert calculations remain **browser-side**. This PR does **not** move the strategy engine or MT5 order execution into Java; browser-closed automatic scanning, off-device notifications, and guaranteed zero-missed alerts require a separately validated worker and delivery mechanism.
- The Java news monitor polls public Google News RSS while the Render worker is awake; results/errors are recorded. Internet providers may reject requests and Render free instances may sleep. The original browser feeds and calendar logic remain enabled, and server headlines are used when browser news sources fail.
- Frontend access toggles are synchronized to `app_permissions`; rigorous back-end feature authorization, notification secret migration, encryption-at-rest of integration tokens, and user-specific signal ownership policies need further design and testing before claiming the whole platform is secured.
- Some legacy UI artwork/media was not in the original GitHub commit. Existing Netlify IndexedDB/localStorage cannot automatically be read on Render's different origin; export/import from the old origin requires a dedicated migration path.
- A successful CI integration test on PostgreSQL does not prove Render production database permissions, broker trading outcomes, live feed availability, or full visual regression. Keep the Netlify version as a fallback throughout staging and regression testing.


### Password policy (staging verification)

| Role | Minimum length | Notes |
| --- | --- | --- |
| Admin | 12 | Required when creating/resetting an admin or promoting another account to admin. Bootstrap follows this rule. |
| User | 5 | No character composition rule; any five characters accepted. |
| Guest | 0 | No length or composition check. Even blank credentials can be configured (not recommended for public deployments). The guest role remains read-only and feature-restricted. |

All account passwords are still BCrypt-hashed in PostgreSQL, never stored in clear text. Account creation and reset in the Admin tab use the server-side role policy. Promoting a guest to user or user to admin requires a new password meeting the higher role minimum and revokes existing sessions; demotion revokes sessions as well. The change does not automatically create old KMR frontend users. Sign in as `kalai` and add `tsuser`, `vino`, and `guest` through the Admin tab.

**Security note:** A blank guest password means anyone can log in with that guest username and read all guest-accessible signal data. Use a simple nonblank password if you want to keep guest access private.
