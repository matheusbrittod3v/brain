# GitHub Incremental Ingestion Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with test-first verification. Steps use checkbox syntax.

**Goal:** Process GitHub webhook commits incrementally from the last successfully ingested commit, while preserving safe full-snapshot recovery, deletion handling, source provenance, and retry behavior.

**Architecture:** Keep `project_repository_heads` as the webhook's accepted HEAD per branch (the `main` row also supports verified-by checks). Add a separate RLS-protected ingestion checkpoint keyed by tenant, project, repository, and branch. Serialize each repository's worker jobs; compare the checkpoint to the incoming push base and fetch only changed file contents when they match. Bootstrap, out-of-sequence work, large diffs, and recovery for an already-current commit use a complete tree snapshot. The worker advances its checkpoint only when every file is handled without a processing error.

**Tech Stack:** TypeScript, pg-boss, PostgreSQL/Drizzle, GitHub REST API.

**Spec:** `docs/superpowers/plans/2026-11-16-product-integration-sequence.md` P3; `docs/04-roadmap/construction-blueprint.md` Stage 2 and section 4; `docs/02-specifications/connector-framework-and-integrations.md` GitHub connector section.

## Global Constraints

- Keep `sourceOrigin` as `internal` or `external_reference` and preserve public repository references as `draft`/`untrusted` with repository-namespaced IDs.
- Use the immutable 40-character commit SHA for each item's `sourceVersion`.
- Preserve Gitleaks fail-closed behavior, file-level error isolation, access policy scope, and audit writes.
- Reprocessing a commit must not create duplicate versions, embeddings, or graph relations; it must still repair missing derived data.
- A partial file-processing failure must not advance the ingestion checkpoint.
- `brain_system` has `BYPASSRLS`; maintenance mutations must include explicit tenant/project/policy predicates.

## Review Focus

- First import or zero `before` SHA: load a full tree and establish a checkpoint.
- Out-of-order commit or force push: full-snapshot recovery must not skip content or move the checkpoint backward.
- Deleted, renamed, or newly secret-bearing files: remove stale searchable items and derived data, then audit the change.
- Compare API cap/truncation or individual content failure: avoid advancing the checkpoint on incomplete data.
- Concurrent jobs for one repository: serialize checkpoint read, ingestion, and advance.

---

### Task 1: GitHub changed-file API

**Files:**
- Modify: `integrations/github/src/index.ts`
- Test: `integrations/github/test/github.test.ts`

**Interfaces:**
- Produce `fetchRepoCommitChanges(owner, repo, baseSha, headSha, token, opts?, fetchFn?)`, returning repository privacy, resolved `headSha`, changed file paths/statuses, removed paths, and a fallback-required flag for compare responses at the 300-file cap.
- Reuse the existing size and path filters; fetch file contents at the immutable head SHA.

- [x] Test compare API request, add/modify/rename/delete status mapping, path filters, base64 decoding, and the 300-file fallback signal (unit suite; 10 tests pass).
- [x] Run the GitHub connector test and observe the new assertions fail before implementation.
- [x] Implement the helper without fetching unchanged files.
- [x] Run `npm --workspace=@noema/connector-github test`; typecheck included in root typecheck.

### Task 2: Durable scoped ingestion checkpoint and source retirement

**Files:**
- Modify: `packages/database/src/schema.ts`, `packages/database/src/operational-repos.ts`, `packages/database/src/repositories.ts`
- Create: `packages/database/drizzle/0026_git_ingestion_heads.sql` and generated Drizzle snapshot/journal entries.
- Test: `packages/database/test/schema.test.ts`, live worker integration.

**Interfaces:**
- Add `git_ingestion_heads(tenant_id, project_id, repository, branch, commit_sha, access_policy_id, updated_at)` with a composite primary key, strict SHA check, explicit RLS policy, and `brain_app` grants.
- Add operational methods to read/advance a checkpoint and hold a repository-scoped transaction advisory lock.
- Add a knowledge-repository method to retire Git sources by repository/path, soft-delete matching items, delete embeddings and attached relations, and return item IDs/policies for audit.

- [ ] Add schema and live tests proving a checkpoint is invisible/out-of-scope and cannot be mutated across tenant/project/policy.
- [ ] Add a live test proving source retirement only affects the requested repository/path and removes vector/graph derivatives while retaining item version history.
- [ ] Run targeted tests and observe failures before adding the schema/repository implementation.
- [x] Generate migration metadata, implement repository operations, and run database tests/typecheck. Live RLS/retirement integration remains unverified in this environment.

### Task 3: Incremental worker orchestration and webhook metadata

**Files:**
- Modify: `apps/api/src/server.ts`, `apps/worker/src/index.ts`, `apps/worker/test/worker.test.ts`, `tests/integration/postgres-worker-live.test.mjs`

**Interfaces:**
- Extend `GitIngestJobPayload` with optional `beforeCommitSha` and `branch`.
- Include push `before` and branch in webhook jobs while keeping manual `/github/ingest` as a full-snapshot request.
- Under the repository lock, compare the persisted checkpoint with `beforeCommitSha`; use changed-file API on a match, otherwise use full-tree recovery.
- Retire deleted/renamed paths and existing sources when Gitleaks rejects their new contents. Do not advance checkpoint when parsing/upsert/audit errors remain.
- Return `{ sourceCommitSha, incremental, checkpointAdvanced, ...counts }` in pg-boss output.

- [x] Add unit and PostgreSQL live tests for changed-file-only ingestion/checkpoint advance, first snapshot, rename/deletion cleanup, force-push full fallback, full-snapshot reconciliation, duplicate-commit replay, no checkpoint advance on a file error, and equal source URI/content hashes isolated across projects and tenants.
- [x] Run unit tests and observe the compare behavior fail before implementing worker/API behavior.
- [x] Implement the lock, compare/fallback path, scoped retire/audit path, full-snapshot reconciliation, and checkpoint advance.
- [x] Run build, full unit suite, and root typecheck. Live PostgreSQL checks pass when pointed at the configured local `DATABASE_SYSTEM_URL`/`DATABASE_URL` after applying migrations: 26-table RLS matrix and pg-boss worker integration.

### Task 4: Documentation and Noema evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-11-16-product-integration-sequence.md`, `docs/04-roadmap/implementation-roadmap.md`.

- [x] Record verified cases: compare cap/divergence fallback (connector unit); changed-file-only ingest, deletion retirement, and no-advance-on-error (worker unit); bootstrap, rename, deletion, snapshot reconciliation, force-push fallback, replay idempotency, item versions, embeddings, and checkpoint state (PostgreSQL live); equal `(sourceUri, contentHash)` isolation across tenant/project; checkpoint RLS (26-table matrix); and worker Git/SaaS/embedding/audit/shutdown behavior (pg-boss live suite).
- [x] Used Noema MCP `brain_context_build`, `brain_validate_implementation` (16 rules, zero violations), and `brain_record_learning` after validation.

