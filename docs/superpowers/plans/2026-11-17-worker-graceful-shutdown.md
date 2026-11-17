# Worker graceful shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker releases its timers, pg-boss, and PostgreSQL clients on SIGTERM or SIGINT.

**Architecture:** Use an idempotent shutdown function around all resources created by `startWorker`. Stop the schedule refresh interval, gracefully stop pg-boss with a bounded wait, then close both database clients. Test the coordinator independently and verify a live process with SIGTERM.

**Tech Stack:** TypeScript, Node.js signals, pg-boss, PostgreSQL.

**Spec:** `../docs/superpowers/specs/2026-11-17-worker-graceful-shutdown-design.md`

## Global Constraints

- Keep job execution graceful and avoid forced process termination.
- Attempt all cleanup steps even when one fails; flush the result and exit only after cleanup attempts finish.
- Keep signal handling idempotent.

## Review Focus

- Duplicate SIGINT/SIGTERM during shutdown: cleanup executes once.
- pg-boss stop failure: both DB clients still close.
- Timed schedule refresher: timer stops before queue shutdown.
- Live process startup: both queues and API continue functioning after worker restart.

---

### Task 1: Shutdown coordinator

**Files:** `apps/worker/src/index.ts`; `apps/worker/test/worker.test.ts`.

**Interfaces:** `createWorkerShutdown(runtime) -> (signal: string) => Promise<void>` where runtime has `stopAccepting`, `stopQueue`, and `closeConnections` callbacks.

- [x] Write tests for order/idempotency and cleanup after pg-boss failure.
- [x] Run the worker test and observe the missing coordinator export.
- [x] Implement coordinator; collect cleanup failures and throw after all close attempts.
- [x] Run worker tests and typecheck.

### Task 2: Wire live worker resources and verify

**Files:** `apps/worker/src/index.ts`; roadmap and progress ledger.

- [x] Preserve the system SQL client from `createDatabaseClient` and close it with `appClient`.
- [x] Register SIGINT/SIGTERM handlers; stop the schedule refresher and call `boss.stop({ graceful: true, timeout: 30_000, wait: true })`.
- [x] Build and run full tests.
- [x] Send SIGTERM to the live worker; verify it exits immediately after cleanup; restart worker and verify it remains online.
- [x] Update roadmap and mark the plan complete.
