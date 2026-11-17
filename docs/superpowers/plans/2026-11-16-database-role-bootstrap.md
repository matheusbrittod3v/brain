# Database Role Bootstrap Implementation Plan

> **For agentic workers:** Use the database-role task brief alongside this plan. Steps use checkbox syntax for tracking.

**Goal:** Provision isolated PostgreSQL roles so API queries are subject to RLS, internal workers/migrations can bypass RLS intentionally, and audit rows remain append-only to the API.

**Architecture:** Keep database owner/admin credentials separate from application and system credentials. A cross-platform TypeScript bootstrap command reads local `.env`, connects using `DATABASE_ADMIN_URL`, provisions login roles and grants, and installs required extensions before migrations. Drizzle migrations use `DATABASE_SYSTEM_URL`; application clients use `DATABASE_URL`.

**Tech Stack:** PostgreSQL 16, TypeScript/Node.js 20+, `postgres` driver, Drizzle Kit, Docker Compose.

**Spec:** `docs/00-normative-decisions.md` (items 51 and 57), `docs/01-architecture/data-model-and-graph.md` (RLS and role requirements), `docs/04-roadmap/local-dev-and-stack.md`.

## Global Constraints

- `brain_app` must be non-owner, `NOSUPERUSER`, and `NOBYPASSRLS`.
- `brain_system` is a dedicated, audited `NOSUPERUSER BYPASSRLS` role for workers/migrations.
- Only the admin/bootstrap connection may create roles and install extensions.
- `audit_logs` grants to `brain_app` include `SELECT` and `INSERT`, never `UPDATE` or `DELETE`.
- The bootstrap runs before migrations and must not grant privileges on tables that do not yet exist; current-table DML grants belong to the migration owner.
- Default table privileges for future objects created by `brain_system` are limited to `SELECT, INSERT`; later write permissions require explicit grants, and `audit_logs` remains append-only.
- Production passwords are supplied out-of-band; do not commit real credentials or log passwords.
- Utility statements cannot bind password parameters through PostgreSQL's extended protocol. Bind passwords to PostgreSQL `quote_literal`, then use only the returned escaped literal in the utility command. The final command and, depending on logging settings, query parameters can still be exposed; document protection and rotation. See [PostgreSQL PL/pgSQL statements](https://www.postgresql.org/docs/16/plpgsql-statements.html) and [protocol flow](https://www.postgresql.org/docs/16/protocol-flow.html).
- npm scripts must work cross-platform; implement bootstrap in TypeScript/Node, not a shell script.
- Do not start Docker or apply migrations in this task; test code paths that do not need a live PostgreSQL server.

## Review Focus

- A missing/empty admin URL or role password must fail before any connection or SQL mutation.
- Role passwords must never be interpolated directly into JavaScript-built SQL, logs, or command arguments; bind them to `quote_literal` and document possible server-side activity/log visibility.
- Re-running bootstrap must be idempotent and restore the required role attributes, schema privileges, extensions, and default privileges; grants on existing tables are deliberately owned by the migration that creates those tables, never by the pre-migration bootstrap.
- Default privileges must apply to future tables created by `brain_system` with only `SELECT, INSERT`; later UPDATE/DELETE requires explicit migration grants.
- `brain_app` must never become table owner or receive `BYPASSRLS`; audit writes must remain append-only.
- Drizzle migration commands must use `DATABASE_SYSTEM_URL`, while bootstrap uses `DATABASE_ADMIN_URL` and application configuration stays on `DATABASE_URL`.

---

### Task 1: Add repeatable local database role provisioning

**Files:**
- Create: `noema/packages/database/src/bootstrap-roles.ts` and focused tests for its environment/SQL planning helpers.
- Modify: `noema/packages/database/package.json` and `package-lock.json` for a cross-platform `db:bootstrap-roles` command and `.env` loading dependency if needed.
- Modify: `noema/packages/database/drizzle.config.ts` to use `DATABASE_SYSTEM_URL` for migration execution.
- Modify: `noema/packages/database/src/rls-and-indexes.sql` and the unapplied initial migration to grant app DML on current tables, then restrict `audit_logs` to `SELECT, INSERT`; these table-level grants live only in the migration (single owner), since the pre-migration bootstrap must not grant on tables that do not exist yet.
- Modify: `noema/.env.example` and `noema/infra/docker/docker-compose.yml` for separate admin/app/system local URLs and passwords.
- Modify: `noema/README.md` with the local bootstrap order and production role expectations.

**Interfaces:**
- Consumes: `DATABASE_ADMIN_URL`, `DATABASE_SYSTEM_URL`, `DATABASE_URL`, `BRAIN_APP_DB_PASSWORD`, and `BRAIN_SYSTEM_DB_PASSWORD`.
- Produces: roles `brain_app` and `brain_system`; app grants and default privileges; required `pgcrypto`/`vector` extensions available before migration.

- [x] Add a pure configuration/planning helper and tests for missing credentials, role attributes, migration URL selection, and audit-log permissions.
- [x] Implement an idempotent TypeScript bootstrap command using the existing PostgreSQL driver and parameterized/escaped password handling.
- [x] Create/update `brain_app` as `LOGIN NOSUPERUSER NOBYPASSRLS` and `brain_system` as `LOGIN NOSUPERUSER BYPASSRLS`; grant schema creation to system as needed.
- [x] Install `pgcrypto` and `vector` using the admin connection before Drizzle migrations run.
- [x] Grant schema/default privileges during bootstrap, with future table defaults limited to `SELECT, INSERT`; migration-owner SQL grants current-table DML and keeps `audit_logs` append-only.
- [x] Route Drizzle migrations through required `DATABASE_SYSTEM_URL`; document bootstrap before migrate and keep app/admin credentials separate.
- [x] Run `npm run typecheck`, `npm run build`, and `npm test`; do not start Docker or apply migrations.

**Manual verification:** Inspect role flags, grants, default privileges, `.env.example`, migration URL selection, and README order. Confirm bootstrap works before tables exist; current table grants are only in the initial migration. Because PostgreSQL is not started, do not claim live role bootstrap or RLS behavior was exercised. Passwords are bound as query parameters to `quote_literal`; the resulting utility command and sometimes query parameters may remain visible in server activity/logs and require protected logs and rotation.
