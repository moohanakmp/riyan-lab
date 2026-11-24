-- Server-collected order flow footprint (display only): one row per symbol and minute,
-- built from exchange trades with the real taker side. Never used for paper entries.
-- cells = [[price, buyVolume, sellVolume], ...] in venue units (OKX contracts, BTC for Coinbase).
CREATE TABLE IF NOT EXISTS order_flow_minutes (
 symbol varchar(12) NOT NULL,
 t bigint NOT NULL,
 o double precision NOT NULL,
 h double precision NOT NULL,
 l double precision NOT NULL,
 c double precision NOT NULL,
 buy double precision NOT NULL,
 sell double precision NOT NULL,
 trades integer NOT NULL,
 partial boolean NOT NULL,
 cells jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (symbol, t)
);
