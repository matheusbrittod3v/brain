# Context Hit Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Track Context Pack delivery and evidence durably per authenticated session, report `hits / distinct items sent`, rank by the item-level session hit rate, and reinforce `CO_ACCESSED_WITH` edges.

**Architecture:** Add a policy-aware PostgreSQL ledger with one row per tenant/project/actor/session/item and separate sent/hit session counters on knowledge items. API and MCP handlers register Context Pack sources, record read/citation/edit evidence, and return the session rate. All ledger/counter/edge writes run atomically under the existing RLS context; edit evidence additionally requires the actor's active task lease.

**Tech Stack:** TypeScript, Fastify, MCP SDK, Drizzle/PostgreSQL, pgvector retrieval, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-17-context-hit-rate-design.md`

## Global Constraints

- Denominator: distinct Context Pack item IDs recorded for `(tenant, project, actor, session)`; direct search results do not count.
- Numerator: those delivered items with at least one of `read`, `citation`, or lease-validated `edit` evidence.
- Repeated delivery and evidence in the same session are idempotent.
- `knowledge_items.hit_count` remains legacy feedback; new ranking uses `context_hit_count / context_sent_count`, clamped to `[0,1]`.
- RLS must filter tenant, project, and each row's access policy; mixed-authority batches are all-or-nothing.
- Only inferred `CO_ACCESSED_WITH` edges are reinforced, and their `created_at` refreshes for the existing 60-day decay.

## Review Focus

- A session reuses an item under different access policy scope: test policy-scoped RLS and prohibit broadening previously recorded rows.
- Two actors reuse the same session string: test tenant/project/actor composite isolation.
- Repeated pack and feedback retries: test denominator, counters, and graph edges stay idempotent.
- Edit evidence without an active lease or with another actor's lease: test it never changes hit rate.
- Legacy `hit_count` is nonzero: test the new rank derives only from session counters.

## File Map

- `packages/core/src/index.ts`: shared session feedback request/result types and session ID validation.
- `packages/database/src/schema.ts`, `packages/database/drizzle/0023_context_session_feedback.sql`, `packages/database/drizzle/meta/0023_snapshot.json`: durable item ledger, RLS, and aggregate item counters.
- `packages/database/src/operational-repos.ts`: transaction-safe registration, evidence, session-rate, and session-hit reads; inferred edge reinforcement in the same transaction.
- `packages/retrieval/src/sql-retrieval.ts`, `packages/retrieval/src/index.ts`: derive ranking boost from session counters.
- `packages/context-engine/src/index.ts`: include access policy in the selected source reference so the handler can persist it without widening scope.
- `apps/api/src/server.ts`: REST Context Pack registration, knowledge-read evidence, useful feedback, edit lease validation, and response metrics.
- `apps/mcp-server/src/index.ts`: session support for context build, knowledge get, and learning; task-lease check and graph feedback.
- `apps/web/src/app/page.tsx`: retain an interaction session ID and pass selected Context Pack source IDs to feedback.
- Tests across database, retrieval, API, and MCP packages; update `docs/02-specifications/mcp-and-api-spec.md`, `docs/01-architecture/retrieval-and-memory.md`, and roadmap status.

---

### Task 1: Persist policy-scoped session item outcomes

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0023_context_session_feedback.sql` (generate with Drizzle, then inspect RLS and role grants)
- Modify: `packages/database/src/operational-repos.ts`
- Test: `packages/database/test/context-session-feedback.test.ts`
- Test: `tests/integration/postgres-context-session-live.test.mjs`

**Interfaces:**
- `ContextSessionItemInput = { itemId: string; accessPolicyId: string; sourceUri: string; taskId?: string }`.
- `ContextSessionHitRate = { sessionId: string; hits: number; itemsSent: number; rate: number | null }`.
- `PgOperationalRepository.recordContextDelivery(ctx, projectId, sessionId, items): Promise<ContextSessionHitRate>`.
- `PgOperationalRepository.recordContextEvidence(ctx, projectId, sessionId, itemIds, evidence): Promise<{ rate: ContextSessionHitRate; newlyHit: Array<{ itemId: string; accessPolicyId: string }> }>`.
- `PgOperationalRepository.recordContextEdits(ctx, projectId, sessionId, taskId, paths): Promise<ContextSessionHitRate>`.
- Validate and normalize session IDs in the core helper; reject missing, overlong, or control-character IDs.

**Steps:**

- [x] Write database tests for first delivery, duplicate delivery, distinct item counts, unique hit evidence, unknown item rejection, and all-or-nothing mixed-policy batches.
- [x] Run `npm -w @noema/database run build && npm -w @noema/database test` and confirm the new tests fail because the ledger/repository methods do not exist.
- [x] Add `context_session_items` with composite identity `(tenant_id, project_id, actor_id, session_id, item_id)`, `access_policy_id`, `source_uri`, `task_id`, `sent_at`, `hit_at`, and `hit_evidence text[]`; enable and force RLS using tenant/project/allowed-policy GUCs.
- [x] Add nonnegative `context_sent_count` and `context_hit_count` counters to `knowledge_items`; preserve existing `hit_count` unchanged.
- [x] Implement transaction-safe repository methods: insert deliveries with conflict no-op, increment sent count only on first row, mark hits only on first evidence, increment hit count once, and compute rate from ledger rows visible in the transaction.
- [x] For each newly hit item, add bidirectional inferred `CO_ACCESSED_WITH` edges to already-hit items from the same session; update confidence with a cap of `1.0` and refresh `created_at` on inferred-edge conflict.
- [x] Implement edit path matching only on delivered rows in the same session and task; run the ledger query and writes under the actor's RLS scope.
- [x] Run the two database test commands again and run `NOEMA_INTEGRATION_DB_URL=$DATABASE_SYSTEM_URL node --test tests/integration/postgres-context-session-live.test.mjs`; confirm isolation, rollback, counters, and edge reinforcement.

### Task 2: Rank by session hit rate

**Files:**
- Modify: `packages/retrieval/src/sql-retrieval.ts`
- Modify: `packages/retrieval/src/index.ts`
- Test: `packages/retrieval/test/sql-retrieval.test.ts`
- Test: `tests/integration/postgres-retrieval-graph-live.test.mjs`

**Steps:**

- [x] Add a test where legacy `hit_count` is positive and session counters are zero; assert `hitRateBoost` is zero.
- [x] Add cases for `context_hit_count / context_sent_count` values `0`, `0.5`, and `1`, and for division-by-zero.
- [x] Change retrieval SELECTs and rank calculation to use the separate session counters, clamped to `[0,1]`; leave the legacy column available only for compatibility.
- [x] Verify SQL cache invalidation after context delivery/evidence and repeat the live retrieval graph integration test.

### Task 3: REST Context Pack, reads, and feedback

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/postgres-api-context-live.test.mjs`
- Create: `apps/api/test/context-session-api.test.mjs`

**Steps:**

- [x] Test REST `/context` persists only returned Context Pack sources and includes a usable session ID and current rate in its response.
- [x] Test REST knowledge GET with the same session ID marks `read`; GET without a session ID does not count as a read.
- [x] Test useful feedback rejects IDs not delivered to that session and atomically marks delivered item IDs as `citation`/use evidence.
- [x] Test edit feedback without an active lease, with another actor's lease, and with a nonmatching source path does not record hits; test a same-actor active lease plus exact delivered path does.
- [x] Add optional `sessionId`/`taskId` fields to `/context`; if omitted, generate one and return it. Persist delivery after pack assembly. Add optional `sessionId` to knowledge GET; require it when useful feedback supplies item IDs.
- [x] Wire active lease validation through the transactional lease check; return the updated hit rate and warnings for edited paths that do not match a delivered source.
- [x] Run API build/tests and live PostgreSQL REST/MCP integration (`tests/integration/postgres-api-context-live.test.mjs`).

### Task 4: MCP session continuity and item evidence

**Files:**
- Modify: `apps/mcp-server/src/index.ts`
- Modify: `apps/mcp-server/test/wave3a-tools.test.mjs`
- Modify: `tests/integration/postgres-api-context-live.test.mjs`

**Steps:**

- [x] Test `brain_context_build` stores its Context Pack sources, returns session ID/rate, and direct `brain_search` does not change the denominator.
- [x] Test `brain_knowledge_get` records one read and `brain_record_learning` marks only delivered `usedItemIds` once, returns the correct rate, and creates/reinforces co-access edges.
- [x] Test `brain_record_learning` validates `editedPaths` against delivered source URIs and requires an active task lease held by the caller.
- [x] Add optional `sessionId` and `taskId` to `brain_context_build`, generate/return a session ID when omitted, and add optional `sessionId` to `brain_knowledge_get`.
- [x] Require `sessionId` when `usedItemIds` or `editedPaths` are provided to `brain_record_learning`; keep summary-only episodic memory valid without feedback.
- [x] Call the repository methods under authenticated context; invalidate retrieval cache after delivery or hits; return `{ recorded, hitRateUpdated, hitRate }`.
- [x] Run MCP build/tests and live PostgreSQL REST/MCP integration (`tests/integration/postgres-api-context-live.test.mjs`).

### Task 5: Web session ID and user-visible metrics

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Test: `apps/web` existing build/typecheck; add a focused unit test only if a session helper is extracted.

**Steps:**

- [x] Keep one cryptographically random session ID for the active interaction session and preserve it while context is built/read/feedback is submitted.
- [x] Send the session ID to REST `/context` and `/search/feedback`; send the source IDs from the returned Context Pack when rating it useful.
- [x] Show the returned `hits / itemsSent` rate, surface request/persistence errors, and do not display an untracked legacy hit count as Context Hit Rate.
- [x] Run `npm -w @noema/web run build` and verify its TypeScript checks.

### Task 6: Docs, full verification, and live use

**Files:**
- Modify: `docs/02-specifications/mcp-and-api-spec.md`
- Modify: `docs/01-architecture/retrieval-and-memory.md`
- Modify: `docs/04-roadmap/implementation-roadmap.md`
- Modify: `docs/superpowers/plans/2026-11-16-product-integration-sequence.md`

**Steps:**

- [x] Update contracts with session ID, distinct delivered-item denominator, evidence types, active lease requirement, and `CO_ACCESSED_WITH` behavior.
- [x] Mark verified sub-capabilities complete; local workspace source edits are detected by comparing first-delivery SHA-256 baselines at task feedback. Remote/unavailable sources remain outside automatic detection.
- [x] Run `npm run build && npm run typecheck && npm test` (full monorepo run passed before final warning-only response additions; affected API/MCP/database builds and tests passed afterward).
- [x] Against the local PostgreSQL service, create a synthetic Context Pack, record a read and citation through Noema, verify `2/3` or the exact expected rate after RLS reads, verify a repeat event is idempotent, and confirm a fresh retrieval engine ranks from persisted session counters.
- [x] Clean up synthetic session, knowledge items, relations, and audit rows; confirm API health and worker queue state afterward.

