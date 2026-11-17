# HumanOps Access Control Persistence Implementation Plan

> **For agentic workers:** Inline execution is selected by the user's request. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Persist access member roles, temporary grants, and custom policy catalog entries across Noema API restarts.

**Architecture:** Add tenant/project-scoped PostgreSQL tables protected by RLS, repository CRUD methods using `withTenantRls`, and wire API handlers to use those methods when PostgreSQL operational stores are enabled. Preserve the existing in-memory fallback for tests and local use without PostgreSQL.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Node test runner, existing RLS transaction helper.

**Spec:** `docs/superpowers/specs/2026-11-17-access-control-persistence-design.md`

## Global Constraints

- Derive tenant and actor only from authenticated `AuthContext`.
- Scope every operation by tenant and project and enforce RLS.
- Treat Keycloak sync status as distinct from durable local persistence.
- Never reveal or revoke a grant outside its tenant/project; preserve 404 for scope mismatch.
- Expired grants are excluded from active-grant listings.

## Review Focus

- Expired grant list after API restart: it remains stored but is not returned as active.
- Cross-project or cross-tenant grant ID: list/revoke must not expose or mutate it.
- Caller with only `public-org`: must not read/write internal administration rows.
- Keycloak configured but unavailable: local record behavior and `syncedWithKeycloak` remain truthful.
- Repeated upsert for same member/policy: updates one record, does not duplicate it.

---

### Task 1: Database schema and RLS migration

**Files:** `packages/database/src/schema.ts`, generated migration/snapshot/journal.

- [ ] Add tables for project members, temporary grants, and custom policies with tenant/project keys and `internal-project` RLS marker.
- [ ] Generate and inspect the migration; enable and force RLS, define fail-closed policies, and grant application DML explicitly.
- [ ] Add schema tests for columns, keys, and policy migration contents.
- [ ] Run database build and migration generation/check.

### Task 2: Tenant-scoped repository operations

**Files:** `packages/database/src/operational-repos.ts`, database tests.

- [ ] Add typed list/upsert/create/revoke methods for all three records using `withTenantRls`.
- [ ] Test upsert idempotency, expired grant filtering, and scoped revoke not-found behavior.
- [ ] Add live PostgreSQL coverage for RLS isolation and survival after repository recreation.

### Task 3: Wire HumanOps API

**Files:** `apps/api/src/server.ts`, API tests.

- [ ] Use repository methods for access profile policy catalog, member listing/upsert, grant list/create/revoke, and custom policy upsert when PostgreSQL stores are active.
- [ ] Preserve in-memory fallback behavior and existing response shapes when PostgreSQL stores are disabled.
- [ ] Keep audit records for successful mutations and ensure out-of-scope IDs produce no mutation.
- [ ] Test API behavior across separate app instances backed by the same PostgreSQL database.

### Task 4: Documentation and verification

**Files:** `docs/02-specifications/capabilities-and-command-center.md`, `docs/02-specifications/mcp-and-api-spec.md`, `docs/04-roadmap/implementation-roadmap.md`.

- [ ] Update access workspace status to distinguish durable local state from optional IdP synchronization.
- [ ] Run database/API builds, focused integration tests, full `npm test`, `npm run typecheck`, and Noema validation.
