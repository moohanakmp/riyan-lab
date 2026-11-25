-- 2026-11-25 review hardening.
-- Trusted devices: a browser that logged in successfully may still log in while the account is locked,
-- so a stranger typing wrong passwords cannot lock the owner out.
CREATE TABLE IF NOT EXISTS auth_trusted_devices (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_trusted_devices_user_idx ON auth_trusted_devices(user_id);
-- Telegram delivery polls these by created_at every 15 s.
CREATE INDEX IF NOT EXISTS auto_signals_created_at_idx ON auto_signals(created_at);
CREATE INDEX IF NOT EXISTS manual_signals_created_at_idx ON manual_signals(created_at);
CREATE INDEX IF NOT EXISTS low_profit_signals_created_at_idx ON low_profit_signals(created_at);
