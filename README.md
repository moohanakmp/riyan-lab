# Riyan Lab — KMR v28 Migration (work in progress)

Target: **Java 21 / Spring Boot / Maven**, **Neon PostgreSQL** in schema `riyan_lab`, original **JavaScript** frontend, and **Render** deployment.

This is an initial persistence migration, **not a verified zero-error or complete server-side rewrite**. The original browser-based signal engine is retained; server-side signal scanning when the browser is closed remains unimplemented.

## API persistence

The Flyway V1 migration creates: `auto_signals`, `manual_signals`, `low_profit_signals`, `analysis_reports`, `seven_day_predictions`, `pnl_reports`, `gold_predictions_actuals`, `research_reports`, `tab_states` and `audit_events`. Each record contains the original JSON payload, and a separate audit event is appended when written.

## Local run

Configure `DATABASE_URL`, `DB_USER`, `DB_PASSWORD`, `RIYAN_API_TOKEN` (no secrets in git). Run `mvn -B verify`, then `mvn spring-boot:run`. A database user with CREATE permission is required for Flyway's `riyan_lab` schema.

## Deployment

Use Render's Blueprint or GitHub integration with `render.yaml`. The GitHub Actions workflow first compiles/tests, then calls Render only on successful `main` builds and only if `RENDER_DEPLOY_HOOK` is configured in GitHub Actions secrets.

## Known limitations

- Legacy frontend sign-in is not a substitute for production backend user authentication; the initial API uses a shared token.
- Existing Netlify IndexedDB history cannot migrate automatically across browser origins; it must be exported or migrated separately.
- UI modules, DB synchronization, and MT5 actions require regression testing before production cutover.
- Neon connectivity, Render runtime, and complete trading correctness are **not verified** in this environment.


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
