-- Independent of browser sessions; no credentials or notification secrets are stored here.
CREATE TABLE background_scanner_settings (
 username varchar(48) PRIMARY KEY REFERENCES auth_users(username),
 enabled boolean NOT NULL DEFAULT true,
 config jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE background_scanner_status (
 username varchar(48) PRIMARY KEY REFERENCES auth_users(username),
 checked_at timestamptz NOT NULL DEFAULT now(),
 state varchar(40) NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Numeric IDs remain compatible with existing UI controls; separate range avoids collisions.
CREATE SEQUENCE background_signal_ids START WITH 7000000000000000 MAXVALUE 8999999999999999;
