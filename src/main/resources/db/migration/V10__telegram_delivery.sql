-- Private per-account Telegram destination; credentials are never returned by the API.
CREATE TABLE telegram_settings (
 username varchar(48) PRIMARY KEY REFERENCES auth_users(username),
 enabled boolean NOT NULL DEFAULT false,
 bot_token text NOT NULL,
 chat_id varchar(150) NOT NULL,
 enabled_since timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_deliveries (
 id bigserial PRIMARY KEY,
 username varchar(48) NOT NULL REFERENCES auth_users(username),
 record_type varchar(40) NOT NULL,
 source_id text NOT NULL,
 payload jsonb NOT NULL,
 state varchar(20) NOT NULL DEFAULT 'PENDING',
 attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(),
 claim_id varchar(36),
 last_error varchar(300) NOT NULL DEFAULT '',
 message_id bigint,
 sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(username,record_type,source_id)
);
CREATE INDEX telegram_delivery_due ON telegram_deliveries(retry_at) WHERE state IN ('PENDING','RETRY','SENDING');
