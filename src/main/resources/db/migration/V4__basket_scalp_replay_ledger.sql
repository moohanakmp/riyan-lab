-- Add basket replay storage in a new migration. V3 already ran in staging
-- and must never be edited after application.
-- Flyway chooses the DB_SCHEMA default schema; all names are schema-local.
CREATE TABLE IF NOT EXISTS basket_scalp_replays (
  LIKE low_profit_signals INCLUDING ALL
);
CREATE INDEX IF NOT EXISTS basket_replays_owner_idx
  ON basket_scalp_replays(created_by,updated_at DESC);
