ALTER TABLE economic_calendar_cache ADD COLUMN primary_retry_at timestamptz NOT NULL DEFAULT to_timestamp(0);
ALTER TABLE economic_calendar_cache ADD COLUMN source_label text NOT NULL DEFAULT 'Forex Factory / Fair Economy';
