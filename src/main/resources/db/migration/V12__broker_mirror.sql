-- Broker mirror: admin-linked MT5 account, mirrored signal orders and an append-only audit trail.
-- No broker password is ever stored. The MT5 terminal holds its own credentials; the app only
-- stores a SHA-256 hash of the connector token that the terminal's bridge EA presents.
CREATE TABLE IF NOT EXISTS broker_accounts (
  id BIGSERIAL PRIMARY KEY,
  owner_username VARCHAR(64) NOT NULL UNIQUE,
  broker VARCHAR(40) NOT NULL DEFAULT 'OctaFX',
  platform VARCHAR(8) NOT NULL DEFAULT 'MT5' CHECK (platform IN ('MT4','MT5')),
  account_login VARCHAR(32),
  account_server VARCHAR(80),
  mode VARCHAR(12) NOT NULL DEFAULT 'DRY_RUN' CHECK (mode IN ('DRY_RUN','EXECUTE')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  mirror_auto BOOLEAN NOT NULL DEFAULT TRUE,
  mirror_manual BOOLEAN NOT NULL DEFAULT FALSE,
  max_lot NUMERIC(10,2) NOT NULL DEFAULT 0.01 CHECK (max_lot > 0 AND max_lot <= 1),
  max_daily_loss_usd NUMERIC(12,2) NOT NULL DEFAULT 20 CHECK (max_daily_loss_usd > 0),
  max_open_positions INT NOT NULL DEFAULT 2 CHECK (max_open_positions BETWEEN 1 AND 20),
  max_orders_per_day INT NOT NULL DEFAULT 10 CHECK (max_orders_per_day BETWEEN 1 AND 200),
  max_signal_age_seconds INT NOT NULL DEFAULT 90 CHECK (max_signal_age_seconds BETWEEN 10 AND 3600),
  max_slippage_pct NUMERIC(6,3) NOT NULL DEFAULT 0.15 CHECK (max_slippage_pct > 0 AND max_slippage_pct <= 5),
  allowed_symbols TEXT NOT NULL DEFAULT 'XAUUSD,XAGUSD,BTCUSD',
  symbol_map JSONB NOT NULL DEFAULT '{"XAUUSD":"XAUUSD","XAGUSD":"XAGUSD","BTCUSD":"BTCUSD"}'::jsonb,
  live_confirmed_by VARCHAR(64),
  live_confirmed_at TIMESTAMPTZ,
  connector_token_hash CHAR(64) UNIQUE,
  connector_token_created_at TIMESTAMPTZ,
  connector_last_seen TIMESTAMPTZ,
  connector_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_orders (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  client_order_id VARCHAR(40) NOT NULL UNIQUE,
  parent_id BIGINT REFERENCES broker_orders(id),
  action VARCHAR(8) NOT NULL CHECK (action IN ('OPEN','MODIFY','CLOSE','PING')),
  signal_type VARCHAR(20),
  signal_source_id VARCHAR(200),
  signal_owner VARCHAR(64),
  symbol VARCHAR(20),
  broker_symbol VARCHAR(40),
  side VARCHAR(4) CHECK (side IN ('BUY','SELL')),
  volume NUMERIC(10,2),
  entry_ref NUMERIC,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  state VARCHAR(12) NOT NULL CHECK (state IN ('DRY_RUN','BLOCKED','QUEUED','DISPATCHED','UNKNOWN',
        'FILLED','DONE','REJECTED','EXPIRED','CANCELLED','CLOSED')),
  state_reason TEXT,
  broker_ticket VARCHAR(40),
  fill_price NUMERIC,
  fill_volume NUMERIC(10,2),
  fill_time TIMESTAMPTZ,
  broker_retcode VARCHAR(20),
  broker_message TEXT,
  close_price NUMERIC,
  profit_usd NUMERIC(14,2),
  closed_at TIMESTAMPTZ,
  account_mode VARCHAR(8),
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One OPEN mirror per app signal; MODIFY/CLOSE children are unique per kind and parent.
CREATE UNIQUE INDEX IF NOT EXISTS broker_orders_signal_open_uq
  ON broker_orders(account_id,signal_type,signal_source_id) WHERE action='OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS broker_orders_child_uq
  ON broker_orders(parent_id,action,stop_loss) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broker_orders_dispatch_idx ON broker_orders(account_id,state,created_at);
CREATE INDEX IF NOT EXISTS broker_orders_recent_idx ON broker_orders(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS broker_order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES broker_orders(id) ON DELETE CASCADE,
  account_id BIGINT REFERENCES broker_accounts(id) ON DELETE CASCADE,
  event VARCHAR(40) NOT NULL,
  actor VARCHAR(64) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broker_order_events_order_idx ON broker_order_events(order_id,id);
CREATE INDEX IF NOT EXISTS broker_order_events_account_idx ON broker_order_events(account_id,id DESC);
