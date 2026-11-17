# Context Source Hash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect whether a delivered Context Pack source changed after delivery and record edit evidence only for that source, session, task, and active actor-owned lease.

**Architecture:** Add secure workspace-file hashing in `workspace-detection`; persist the first SHA-256 baseline per context-session item in PostgreSQL; REST/MCP compute changed source URIs at feedback and pass only detected changes to the transactional edit recorder. Manual path hints may narrow feedback but cannot manufacture an edit hit.

**Tech Stack:** TypeScript, Node `crypto`/`fs`, Drizzle/PostgreSQL RLS, Fastify, MCP SDK, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-17-context-source-hash-design.md`

## Global Constraints

- Only files resolving to regular files inside the configured project workspace can be hashed.
- Persist digests only; never persist source file contents.
- A session keeps its first delivery hash when a source is delivered again.
- Edit hits still require the same actor/project/session/task and a current actor-owned lease locked during write.
- Non-workspace, remote, unavailable, unchanged, or unmatched sources do not produce hits and return warnings where a client requested an edit check.

## Review Focus

- Source URI traversal and symlink escape: test that neither is read or credited.
- File already dirty before Context Pack delivery: test that unchanged baseline state does not count as a session edit.
- File changes after delivery with no `editedPaths`: test automatic detection and hit recording.
- Repeated delivery after a file changes: test that the original hash stays fixed and the change is still detectable.
- Lease expiry/reassignment during write: retain same-transaction row lock and lease validation tests.

## File Map

- `packages/workspace-detection/src/index.ts`: secure source hash and changed-source helpers.
- `packages/workspace-detection/test/`: unit tests for file hashing, changes, missing files, traversal, and symlink escape.
- `packages/database/src/schema.ts`, `packages/database/drizzle/0024_context_source_hash.sql`, snapshot/journal: nullable first-delivery `source_hash`.
- `packages/core/src/index.ts`, `packages/database/src/operational-repos.ts`: source hash input, persistence, and delivery hash candidates.
- `apps/api/package.json`, `apps/mcp-server/package.json`: workspace-detection dependency.
- `apps/api/src/server.ts`, `apps/mcp-server/src/index.ts`: baseline hashes on Context Pack delivery and automatic comparison on task feedback.
- `tests/integration/postgres-api-context-live.test.mjs`, `tests/integration/postgres-context-session-live.test.mjs`: durable baseline, automatic edit, repeated delivery, lease and cleanup behavior.
- `docs/00-normative-decisions.md`, API/MCP spec, architecture, roadmap: describe automatic file evidence and remaining non-file limitation.

---

### Task 1: Secure workspace source hashing

**Interfaces:** `hashWorkspaceSources(root, sourceUris): Promise<Array<{ sourceUri: string; sourceHash: string }>>`; `findChangedWorkspaceSources(root, baselines): Promise<string[]>`.

- [x] Write workspace tests for unchanged, changed-after-delivery, missing-after-delivery, external URI, traversal and symlink escape.
- [x] Run the workspace-detection tests and observe the new API is missing.
- [x] Implement safe root containment and SHA-256 hashing for regular files only.
- [x] Build and run workspace-detection tests.

### Task 2: Persist first-delivery hashes

**Interfaces:** extend `ContextSessionItemInput` with `sourceHash?: string`; add `PgOperationalRepository.getContextEditCandidates(ctx, projectId, sessionId, taskId)` returning only actor/session/task-scoped `{ sourceUri, sourceHash }` rows.

- [x] Add repository/schema tests for first-hash persistence and unchanged hash on repeated delivery.
- [x] Add migration 0024 and Drizzle snapshot/journal entry.
- [x] Persist the hash and expose authorized same-session edit candidates under RLS.
- [x] Run database tests and live session-ledger integration.

### Task 3: REST and MCP automatic edit evidence

- [x] Add test workspace files to live API/MCP integration; baseline them at Context Pack build and modify them afterward.
- [x] REST/MCP Context Pack handlers hash only returned source URIs under each project's configured workspace root.
- [x] On task feedback, derive actual changed source URIs from database baselines and workspace content; accept caller path hints only when they match detected changes.
- [x] Verify unchanged/pre-existing files, new edits, wrong task/session, missing lease, other actor lease, and invalid workspace paths.
- [x] Return warnings for unchanged/unhashable/mismatched paths and invalidate retrieval cache after newly recorded hits.
- [x] Run API/MCP builds, package tests, and live REST/MCP PostgreSQL integration.

### Task 4: Docs and complete verification

- [x] Update normative contract and roadmap to state hash-based local file evidence and its limits for non-file sources.
- [x] Run `npm run build && npm run typecheck && npm test`.
- [x] Run live PostgreSQL session, API/MCP, and retrieval-ranking integrations; confirm synthetic files, rows, and leases are cleaned and API health returns ok.
