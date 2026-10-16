-- V3: isolated paper-only basket scalping ledger; respects Flyway DB_SCHEMA.
-- Retain the full entry/exit snapshots in payload and standard audit fields from V2.
CREATE TABLE IF NOT EXISTS basket_scalp_sessions (
  LIKE low_profit_signals INCLUDING ALL
);
CREATE TABLE IF NOT EXISTS basket_scalp_positions (
  LIKE low_profit_signals INCLUDING ALL
);
CREATE TABLE IF NOT EXISTS basket_scalp_events (
  LIKE low_profit_signals INCLUDING ALL
);
CREATE TABLE IF NOT EXISTS basket_scalp_replays (
  LIKE low_profit_signals INCLUDING ALL
);
CREATE INDEX IF NOT EXISTS basket_sessions_owner_idx
  ON basket_scalp_sessions(created_by,updated_at DESC);
CREATE INDEX IF NOT EXISTS basket_positions_owner_idx
  ON basket_scalp_positions(created_by,updated_at DESC);
CREATE INDEX IF NOT EXISTS basket_events_owner_idx
  ON basket_scalp_events(created_by,updated_at DESC);
CREATE INDEX IF NOT EXISTS basket_replays_owner_idx
  ON basket_scalp_replays(created_by,updated_at DESC);
