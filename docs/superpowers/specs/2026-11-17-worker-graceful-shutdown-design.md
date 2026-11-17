# Worker graceful shutdown design

## Intent

When the Noema worker receives `SIGTERM` or `SIGINT`, it should stop its schedule refresher, ask pg-boss to stop gracefully, close the PostgreSQL system and application clients, and then exit with the matching status after cleanup and log flushing. This closes the live operational gap called out in the roadmap.

## Approaches

1. **Only call `boss.stop()`:** small change, but leaves database pools and the runner schedule interval alive.
2. **One idempotent shutdown coordinator for all worker resources (chosen):** stop background polling, gracefully stop pg-boss with a bounded wait, then close both clients. The same coordinator handles both signals and concurrent repeat requests.
3. **Force process exit immediately on signal:** rejected because it can abandon active jobs and bypass resource cleanup.

Use approach 2 because the worker owns multiple long-lived resources and the existing `startWorker` function creates all of them. After all cleanup attempts finish, flush the completion or failure log and exit; this prevents sockets outside the worker’s direct control from keeping a stopped process alive.

## Acceptance

- SIGINT and SIGTERM use the same idempotent shutdown path.
- Stop scheduling before stopping workers.
- pg-boss receives graceful stop with a 30-second timeout.
- PostgreSQL client close operations are attempted even if pg-boss stop fails.
- Unit tests prove order, idempotency, and cleanup after a failure.
- A live worker exits on SIGTERM after cleanup and can be restarted; API health stays OK.
