# HumanOps Access Control Persistence — design

## Intent

Keep project member-role assignments, temporary grants, and custom policy catalog entries after API restarts. These records support the HumanOps access workspace and must remain isolated by tenant and project.

## Goals

- Persist admin state in PostgreSQL when the API is configured for PostgreSQL stores.
- Enforce tenant, project, and internal administration policy scope with RLS and authenticated context.
- Keep temporary grants project-scoped for listing and revocation, with expiry applied on reads.
- Preserve current API response shapes and the in-memory path for local tests/development without PostgreSQL.
- Keep audit events for create, update, and revoke actions.

## Non-goals

- Replace the OIDC provider as the authority for authenticated roles or effective policy grants.
- Implement Keycloak user discovery, role removal/reconciliation, or distributed synchronization retries.
- Persist unrelated integration fallback owners, reconnection history, or FinOps quotas in this change.

## Approach

Add three PostgreSQL tables for project access members, temporary access grants, and custom policy catalog entries. Give each record tenant/project scope and a fixed `internal-project` RLS policy marker; authorize route calls before repository access. Store arrays as PostgreSQL `text[]`, use a composite unique key for member and policy upserts, and scope every grant read/revoke by tenant and project. Add repository methods that run through `withTenantRls`; API routes use them when PostgreSQL operational stores are enabled and retain their existing in-memory fallback otherwise.

## Constraints

- The authenticated `AuthContext` is the only source for tenant and actor identity.
- Project and policy authorization occurs before database operations; RLS remains a second boundary.
- Temporary grant deletion must be conditional on `(tenant_id, project_id, grant_id)` and return not-found when the scope does not match.
- No migration may remove or rewrite existing knowledge, audit, or operational records.
- `syncedWithKeycloak` reports external sync status; local persistence alone does not mean the identity provider changed.

## Verification

- Test schema and RLS policies for all three tables.
- Live PostgreSQL tests create records, close/recreate repository/API state, and confirm records survive.
- Verify tenant/project reads and grant revocation cannot cross scope, expired grants are omitted, and authorized updates are auditable.
- Run migration checks, database/API builds, the full test suite, and the Noema implementation validator.
