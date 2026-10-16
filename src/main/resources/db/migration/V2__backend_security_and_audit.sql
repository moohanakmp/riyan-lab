-- Preserve V1 data while adding server-owned identity, provenance and diagnostics.
CREATE TABLE IF NOT EXISTS riyan_lab.auth_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(12) NOT NULL CHECK (role IN ('admin','user','guest')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS riyan_lab.auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES riyan_lab.auth_users(id) ON DELETE CASCADE,
  csrf_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON riyan_lab.auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS riyan_lab.app_permissions (
  role VARCHAR(12) NOT NULL,
  feature VARCHAR(40) NOT NULL,
  allowed BOOLEAN NOT NULL,
  changed_by VARCHAR(64) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(role, feature)
);
CREATE TABLE IF NOT EXISTS riyan_lab.user_activity (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60),
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_activity_by_actor_idx ON riyan_lab.user_activity(username, created_at DESC);
CREATE TABLE IF NOT EXISTS riyan_lab.news_feed_items (
  id BIGSERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  headline TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  published_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(symbol, source_url)
);
CREATE TABLE IF NOT EXISTS riyan_lab.news_fetch_runs (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(80) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  status VARCHAR(16) NOT NULL,
  found_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS riyan_lab.news_alerts (
  LIKE riyan_lab.auto_signals INCLUDING CONSTRAINTS INCLUDING INDEXES INCLUDING DEFAULTS
);
-- Record full signal conditions (and retain the original JSONB verbatim).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auto_signals','manual_signals','low_profit_signals','analysis_reports',
    'seven_day_predictions','pnl_reports','gold_predictions_actuals',
    'research_reports','tab_states','news_alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS created_by VARCHAR(64)',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64)',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS reason TEXT',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS timeframe TEXT',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS entry_price NUMERIC',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS stop_loss NUMERIC',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS take_profit_1 NUMERIC',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS take_profit_2 NUMERIC',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS take_profit_3 NUMERIC',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS signal_conditions JSONB',t);
    EXECUTE format('ALTER TABLE riyan_lab.%I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()',t);
  END LOOP;
END $$;
