-- Append-only migration: do not change previously applied Flyway migrations.
CREATE TABLE paper_engine_leases (
    username varchar(48) PRIMARY KEY,
    owner varchar(80) NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE paper_signal_keys (
    username varchar(48) NOT NULL,
    signal_key varchar(200) NOT NULL,
    record_type varchar(40) NOT NULL,
    source_id varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(username,signal_key)
);
