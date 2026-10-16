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
