# Database Bootstrap Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a reproducible initial PostgreSQL migration aligned with the authoritative Noema schema and security decisions, including the required extensions, indexes, and tenant/project/policy RLS.

**Architecture:** Use Drizzle Kit to generate the base table migration from `packages/database/src/schema.ts`. Align schema fields and constraints explicitly required by the authoritative data model, then include the security SQL in the initial migration. Do not connect API or MCP runtime stores to PostgreSQL in this task; persistence adapters and database roles are separate tasks.

**Tech Stack:** Node.js 20+, npm workspaces, TypeScript, Drizzle ORM/Drizzle Kit, PostgreSQL 16, pgvector.

**Spec:** `docs/00-normative-decisions.md` (items 25–26, 51, 74), `docs/01-architecture/data-model-and-graph.md` (DDL and RLS contracts), and `docs/04-roadmap/construction-blueprint.md` (Stage 0).

## Global Constraints

- PostgreSQL 16 with `pgvector >= 0.8` is the local database target.
- All multi-tenant reads and writes must be restricted by `app.current_tenant_id`; project-scoped tables must also check `app.allowed_projects`, and policy-scoped tables must also check `app.allowed_policies`.
- Vector search uses `bge-m3` embeddings with 1024 dimensions.
- The generated `search_vector` includes item `id`, `title`, `summary`, `content`, and `tags`, with a GIN index.
- Knowledge relations have the authoritative unique key `(tenant_id, from_project_id, to_project_id, from_item_id, to_item_id, relation_type)`.
- Do not create an HNSW index until benchmarks and tenant/policy isolation checks authorize it; initial vector retrieval uses exact scans over the authorized subset.
- Application connections must use a non-owner role without `BYPASSRLS`; the dedicated `brain_system` role is reserved for audited internal workers and migrations.
- Preserve `noema/packages/database/src/schema.ts` except for fields and constraints explicitly required by the authoritative data model.
- Keep the setup usable without starting Docker; migration generation must be offline, while applying it requires PostgreSQL.

## Review Focus

- A fresh database must have every table before any index or policy references it.
- Reapplying the SQL additions must not fail due to already-created extensions, indexes, or policies.
- Every multi-tenant table must enforce its documented tenant boundary; project-scoped rows must also check allowed projects; policy-scoped rows must also check allowed policies.
- Audit rows must include `access_policy_id`; absent GUCs must fail closed.
- The pgvector column must retain 1024 dimensions; no approximate HNSW index is created in this stage.
- Full-text search must index IDs and tags as specified by the data model; relation uniqueness and concise FK names must match the schema snapshot.
- The generated migration journal and SQL must match the schema source and be present under `noema/packages/database/drizzle/`; this workspace has no Git metadata, so changes cannot be committed here.

---

### Task 1: Generate and secure the initial database migration

**Files:**
- Modify: `noema/packages/database/drizzle.config.ts` only if needed for reliable workspace invocation.
- Create: `noema/packages/database/drizzle/0000_*.sql` and the Drizzle migration journal via `db:generate`.
- Modify: the generated initial migration to include the SQL currently in `noema/packages/database/src/rls-and-indexes.sql`, preserving required ordering and idempotency.
- Modify: `noema/packages/database/src/schema.ts` to align `audit_logs.access_policy_id` and the embedding composite foreign key with the authoritative data model.
- Modify: `noema/packages/database/src/schema.ts` to include the generated full-text vector, relation uniqueness, and an explicit short name for the embedding FK.
- Modify: `noema/packages/database/src/rls-and-indexes.sql` to align all policies, project scoping, and indexes with the authoritative data model.
- Modify: `noema/README.md` to document generating and applying migrations in order.

**Interfaces:**
- Consumes: Drizzle tables exported from `noema/packages/database/src/schema.ts`.
- Produces: a Drizzle migration chain runnable with the existing `@noema/database` `db:migrate` script against a fresh PostgreSQL 16 database.

- [x] Align the Drizzle schema with the authoritative `audit_logs.access_policy_id` and embedding-to-item composite foreign key.
- [x] Generate the initial migration and journal from the aligned schema; inspect the SQL for all tables and columns.
- [x] Add `pgcrypto` and `vector` extensions before table/index statements that need them; add the FTS, tag, filter, and graph indexes after their tables.
- [x] Omit HNSW; retain exact authorized vector retrieval until benchmark and isolation checks pass.
- [x] Add tenant RLS to `organizations` and tenant/project RLS to `projects`; add tenant/project/policy RLS to knowledge tables and audit logs, using `__org__` where the authoritative spec defines organization scope.
- [x] Make each write policy's `WITH CHECK` explicit and match its `USING` condition; enable RLS on all seven tenant tables.
- [x] Ensure migration SQL is repeatable where supported and document that Drizzle applies each migration once.
- [x] Document the GUCs (`app.current_tenant_id`, `app.allowed_projects`, `app.allowed_policies`), fail-closed behavior, role separation, and migration commands in the README.
- [x] Review the migration journal, generated SQL, and README commands to confirm a fresh database has a complete initialization path.
- [x] Add a stored `search_vector` generated column over `id`, `title`, `summary`, `content`, and `tags`, plus its GIN index.
- [x] Add the authoritative unique constraint for `knowledge_relations` and give the composite embedding FK a stable name shorter than PostgreSQL's 63-byte identifier limit.
- [x] Regenerate the initial migration, snapshot, and journal; run the existing project build/typecheck/test scripts as appropriate after the schema changes.

**Manual verification:**
- Run `npm run -w @noema/database db:generate` and confirm there are no schema changes after generating the migration SQL, snapshot, and journal under `noema/packages/database/drizzle/`.
- Inspect the output for all schema entities, the 1024-dimensional vector column, exact-search indexes, and complete RLS; confirm there is no HNSW index. Do not apply it until PostgreSQL is available.
- Confirm the generated FTS expression includes all five source fields, relation uniqueness is present, and the FK constraint name is stable and concise.
