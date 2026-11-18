# Auth Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate account access from AI/API integrations and make session status and password guidance clear.

**Architecture:** Keep existing API endpoints and `AuthModal`; organize its navigation into account and integrations sections. Resolve the saved credential against `/v1/auth/me` with explicit loading and invalid states in the page.

**Tech Stack:** Next.js, React, TypeScript, lucide-react.

**Spec:** `docs/superpowers/specs/2026-11-17-auth-flows-design.md`

## Global Constraints

- Preserve existing login, registration, OAuth2, API key and logout behaviors.
- Do not add a password recovery claim or endpoint.
- Preserve unrelated local changes in the same files.

## Review Focus

- A rejected or unavailable `/me` response must not leave a stale user visible; tie this behavior to Task 1.
- Changing API URL while a request is pending must not apply an older response; tie this behavior to Task 1.
- A user without an account must be able to find registration when enabled; tie this behavior to Task 2.
- A logged-in user must see their identity and logout action without being shown a confusing login form; tie this behavior to Task 2.
- AI/MCP authorization must remain separate and usable; tie this behavior to Task 2.

## File Map

- Modify `apps/web/src/app/page.tsx`: add explicit session resolution and clear invalid session state.
- Modify `apps/web/src/components/AuthModal.tsx`: create distinct account/integrations navigation and concise user guidance.

## Tasks

### Task 1: Resolve session status from the active API

**Files:**
- Modify: `apps/web/src/app/page.tsx`

- [x] Track `checking`, `authenticated`, and `anonymous` session states; reset to checking when API URL or key changes.
- [x] Ignore stale async responses on cleanup; clear `currentUser` for non-OK responses, malformed identities, and network errors.
- [x] Keep the existing account header behavior, showing a pending state while session verification runs.
- [x] Verify with `npm run typecheck --workspace @noema/web`.

### Task 2: Separate account and integration flows

**Files:**
- Modify: `apps/web/src/components/AuthModal.tsx`

- [x] Replace four peer tabs with two clear sections: `Conta` (login/register/session) and `Integrações` (OAuth2/API key); retain accessible entry points for both.
- [x] When a user is logged in, show the account/session card and logout action instead of the login form; offer account creation only when registration is enabled and a user is logged out.
- [x] Add a brief sign-in guide for email and password, and explain that forgotten passwords require contacting the organization administrator because recovery is unavailable.
- [x] Make form and section navigation wrap or scroll on narrow screens; preserve loading, success, and error messaging.
- [x] Verify with `npm run typecheck --workspace @noema/web`.

### Task 3: Align entry points and handoff text

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/AuthModal.tsx`

- [x] Route the existing OAuth2 and API key header shortcuts to the integrations section; route profile and sign-in buttons to the account section.
- [x] Review copy against the available API behavior and the design spec.
- [x] Verify with `npm run typecheck --workspace @noema/web`.

Execution note: automated tests were not added or run; only the requested UI and session flow changes were made, and type checking plus the Noema advisory validator were run.
