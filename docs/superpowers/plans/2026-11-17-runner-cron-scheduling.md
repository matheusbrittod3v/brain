# Brain Runner Cron Scheduling Implementation Plan

> **For agentic workers:** This plan is being executed inline in the current session. Steps use checkbox syntax for tracking.

**Goal:** Make cron delegation produce recurring, durable Brain Runner tasks, with project-scoped schedule listing and cancellation.

**Architecture:** Store each recurring schedule in pg-boss under a unique queue name. The worker discovers scheduled queue names and registers consumers; each firing materializes a normal `runner_tasks` row using the pg-boss job ID as an idempotent task ID. MCP/API validate project scope before creating, listing, or deleting schedules.

**Tech Stack:** TypeScript, pg-boss 10, PostgreSQL, Drizzle, Node test runner, MCP Streamable HTTP.

**Spec:** `protocols/runner-tasks/schema.json`; `docs/02-specifications/brain-runner-subagent.md`; `docs/02-specifications/mcp-and-api-spec.md`.

## Global Constraints

- Runner jobs remain draft-only and retain tenant/project/policy scope.
- Repeated job delivery must not create duplicate task rows.
- Cron schedule metadata must be scoped by tenant and project before listing or cancellation.
- Existing non-cron task enqueue behavior remains unchanged.

## Review Focus

- Invalid cron expressions fail without leaving a queue or schedule behind.
- Repeated pg-boss delivery writes the same task ID and does not duplicate work rows.
- A caller cannot list or cancel another project's schedule by guessing an ID.
- Worker startup discovers schedules created after the worker starts.
- Cancelling a schedule removes future firings and does not delete already materialized tasks.

---

### Task 1: Shared schedule lifecycle and MCP delegation

**Files:**
- Create `apps/mcp-server/src/runner-schedules.ts`.
- Modify `apps/mcp-server/src/index.ts`, `apps/mcp-server/package.json`.
- Test `apps/mcp-server/test/runner-schedules.test.mjs`, `apps/mcp-server/test/mcp-contract.test.mjs`.

**Interfaces:** `createRunnerSchedule(payload, cron, databaseUrl) -> scheduleId`; `listRunnerSchedules(scope, databaseUrl)`; `cancelRunnerSchedule(scope, scheduleId, databaseUrl) -> boolean`. SQL MCP runtime exposes an optional scheduler and `brain_delegate_task` returns a schedule result when cron is present.

- [x] Test invalid cron cleanup, successful schedule creation, exact project filtering, authorized cancel, and cross-project cancel denial.
- [x] Test MCP cron delegation returns `status: scheduled`; regular delegation still returns a queued task.
- [x] Implement unique queue names and schedule lifecycle using pg-boss.
- [x] Build and run focused MCP tests.

### Task 2: Worker discovery and idempotent materialization

**Files:**
- Modify `apps/worker/src/index.ts`.
- Test `apps/worker/test/runner-schedules.test.mjs`.

**Interfaces:** Worker refreshes schedule consumers from `boss.getSchedules()` and materializes each firing as a normal durable RunnerTask with `taskId = RUN-${job.id}`.

- [x] Test worker discovers a schedule and materializes a job with a stable task ID.
- [x] Implement periodic discovery for schedules created after worker startup and queue consumers that persist through `PgOperationalRepository.saveScheduledRunnerTask`.
- [x] Run worker tests; persistence uses the existing `runner_tasks` table and queued state consumed by the Runner daemon.

### Task 3: API management and documentation

**Files:**
- Modify `apps/api/src/server.ts`, `apps/api/test/mcp-parity.test.mjs` or add `apps/api/test/runner-schedules.test.mjs`.
- Modify `docs/02-specifications/mcp-and-api-spec.md`, `docs/02-specifications/brain-runner-subagent.md`.

- [x] Expose project-scoped list and delete endpoints and wire the same scheduler into Streamable HTTP MCP.
- [x] Test schedule listing/cancellation scope through the API and verify MCP `tools/list` remains canonical.
- [x] Update docs to describe UTC cron behavior, durable firing semantics, and required pg-boss worker availability.
- [x] Run root build, typecheck, and test suite.
