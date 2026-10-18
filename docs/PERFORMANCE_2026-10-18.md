# Browser performance and refresh reliability

Verified issues:
- History synchronization read the pending/sent maps and rewrote the full pending queue for every history row. In a local in-memory storage fixture with 1,000 small records this took 441 ms, 2,000 reads and 1,000 writes before the change. Browser localStorage can be slower; this is not a device UI benchmark.
- Initial price requests waited behind paginated historical candle requests.
- Timer/foreground candle resynchronization and metal quote requests could overlap.
- Reopening Analysis during an in-flight request could repeat the same news/calendar work. A rejected refresh could leave its loading flag set.

Changes:
- Batch history/snapshot queue updates with synchronous durability before return. Preserve ownership, deduplication, record-size checks and independent handling of invalid records. Avoid rewriting unchanged pending data.
- Start quotes concurrently with initial history loading; keep trading startup checks and cadence unchanged.
- Share in-flight candle/metal-quote requests, releasing the slot after success or failure.
- Coalesce Analysis requests and clear loading state in finally. Update feed notices only for visible panels; navigation refreshes the newly visible panel.

Validation:
- check-performance.cjs verifies 1,000 records survive with two reads and one write, payload updates/deduplication, owner/guest isolation, malformed-record isolation, shared-request recovery and quote startup ordering.
- Same fixture after change: about 2.5 ms. Timing is informational; deterministic storage-operation and correctness assertions are the CI checks.
- Existing trading, basket, BTC, reference, public-routing, sync and frontend regressions remain required. Java/PostgreSQL integration runs in CI.
- Provider HTTP 429/451 restrictions and Render free-tier cold starts are separate limits; these changes do not claim to remove them.
