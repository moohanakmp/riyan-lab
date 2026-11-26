-- Why the server background scanner did NOT trade: one row per user, symbol and strategy
-- each time the skip reason changes (numbers ignored), with first/last time it was seen.
-- Kept 3 days. Read-only diagnostics; never used for entries.
CREATE TABLE IF NOT EXISTS background_scanner_reasons (
 id bigserial PRIMARY KEY,
 username varchar(64) NOT NULL,
 symbol varchar(12) NOT NULL,
 strategy varchar(16) NOT NULL,
 reason varchar(400) NOT NULL,
 reason_key varchar(400) NOT NULL,
 first_seen timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_scanner_reasons_latest ON background_scanner_reasons(username,symbol,strategy,id DESC);
CREATE INDEX IF NOT EXISTS background_scanner_reasons_seen ON background_scanner_reasons(last_seen);
