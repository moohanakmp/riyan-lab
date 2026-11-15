-- Link test (PING) carries every mapped broker symbol so the EA can check each one in a single tap.
ALTER TABLE broker_orders ALTER COLUMN broker_symbol TYPE VARCHAR(160);
