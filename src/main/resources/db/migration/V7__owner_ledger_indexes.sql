-- Indexed owner restoration and scanner lookups; no historical records are removed.
CREATE INDEX IF NOT EXISTS auto_signals_owner_updated_idx ON auto_signals(created_by,updated_at DESC,source_id DESC);
CREATE INDEX IF NOT EXISTS manual_signals_owner_updated_idx ON manual_signals(created_by,updated_at DESC,source_id DESC);
CREATE INDEX IF NOT EXISTS low_profit_owner_updated_idx ON low_profit_signals(created_by,updated_at DESC,source_id DESC);
CREATE INDEX IF NOT EXISTS user_states_owner_updated_idx ON user_states(created_by,updated_at DESC);
