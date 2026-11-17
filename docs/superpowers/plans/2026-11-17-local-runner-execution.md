# Local Runner Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented local Runner usable end-to-end with durable Edge tasks, Ollama execution, and inspectable results.

**Architecture:** Keep task storage in `@noema/database-edge`, run the existing draft-only daemon from the CLI, and adapt Edge task claim/completion to the Runner source interface. The CLI owns process signals and database lifetime.

**Tech Stack:** TypeScript, Node.js, SQLite/SQLCipher, existing `@noema/agent-runner` Ollama adapter.

**Spec:** `docs/superpowers/specs/2026-11-17-local-runner-execution-design.md`

## Global Constraints

- Local CLI storage remains SQLCipher-required and keychain-backed.
- Runner tasks remain draft-only; destructive instructions are escalated.
- No provider is reported ready unless an execution adapter exists.
- Ollama model downloads happen only with explicit `--pull`.

## Review Focus

- Existing Edge databases migrate without losing queued tasks; test opening a v3 fixture and reading it after migration.
- Failed Ollama execution marks the task failed while keeping the daemon alive; test with an executor that rejects once.
- SIGINT/SIGTERM stops polling and closes the database; test lifecycle through an injected wait/signal harness.
- Destructive instructions stay blocked before model execution and persist as `escalated`; test the real queue/daemon path.
- Unsupported provider selection fails clearly; test known unsupported name and provider default.
- Draft output and token usage persist; test enqueue → claim → complete → list against a temporary Edge database.

---

### Task 1: Persist Edge Runner outcomes

**Files:** `packages/database-edge/src/index.ts`, `packages/database-edge/test/edge.test.ts`

**Interfaces:** Extend `EdgeRunnerTask` with optional `resultSummary` and `modelUsage`; extend `completeRunnerTask(taskId, status, resultSummary?, modelUsage?)`; add `listRunnerTasks(projectId?)`.

- [x] Write tests for migration from schema v3, storing completion/error details, and listing queued/completed tasks.
- [x] Run the tests and confirm they fail because outcome fields/listing are absent.
- [x] Add schema v4 migration and persistence methods.
- [x] Run database-edge build and tests.

### Task 2: Adapt Edge queue to the Runner daemon

**Files:** `apps/cli/src/local-runner.ts` (new), `apps/cli/test/cli.test.ts`, `apps/cli/package.json`

**Interfaces:** Export `createEdgeRunnerTaskSource(db: EdgeDatabase): RunnerDaemonTaskSource` and `startEdgeRunner(db, options?)` returning `RunnerDaemonHandle`.

- [x] Add a test that processes a queued task with an injected executor and persists its draft result and usage.
- [x] Run the test and confirm it fails because the adapter is missing.
- [x] Add the adapter and dependency on `@noema/agent-runner`.
- [x] Run CLI build and targeted tests.

### Task 3: Expose local enqueue, list, and daemon lifecycle

**Files:** `apps/cli/src/index.ts`, `apps/cli/test/cli.test.ts`

- [x] Add tests for `task enqueue --local`, `task list --local`, and unsupported provider errors via exported command helpers or injected CLI IO.
- [x] Verify destructive local tasks are persisted as `escalated` and never reach the executor.
- [x] Run tests and confirm missing command behavior.
- [x] Wire `runner up --local` to preflight Ollama, start daemon, remain alive, and stop/close on signals. `task` local commands use the same SQLCipher/Keychain Edge database.
- [x] Reject unimplemented provider modes before printing ready.
- [x] Run CLI build and all CLI tests.

### Task 4: Verify end-to-end behavior and docs

**Files:** `docs/02-specifications/brain-runner-subagent.md`, `docs/04-roadmap/implementation-roadmap.md`

- [x] Update usage examples and status to match the implemented local command behavior.
- [x] Run `npm run build`, `npm run typecheck`, `npm test`, and an end-to-end temporary Edge test proving enqueue → execution → result listing.
- [x] Ollama was unavailable; a temporary local Ollama-compatible HTTP fixture exercised the real CLI, SQLCipher Edge database, task enqueue, daemon, SIGTERM shutdown, and result listing without pulling or contacting a model service.
