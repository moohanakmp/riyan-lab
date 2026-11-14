-- A provider-validated shared schedule and retry window; never a browser-supplied feed.
CREATE TABLE economic_calendar_cache (
 id integer PRIMARY KEY CHECK(id=1),
 payload jsonb,
 fetched_at timestamptz,
 etag varchar(500) NOT NULL DEFAULT '',
 next_attempt_at timestamptz NOT NULL,
 last_error varchar(1000) NOT NULL DEFAULT '',
 last_http_status integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
