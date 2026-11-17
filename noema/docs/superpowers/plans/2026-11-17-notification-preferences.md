# HumanOps Notification Preferences Implementation Plan

**Goal:** Let each authenticated person choose channels, categories, and delivery frequency for project notifications.

**Architecture:** Persist one preference record per tenant/project/actor/access policy under RLS. Expose self-service GET/PUT routes, apply preferences before outbound notification delivery, and add controls to the Command Center Inbox. OIDC `sub` distinguishes people; local API-key mode continues to represent its single `local-dev` identity.

**Tech Stack:** Fastify, Drizzle/PostgreSQL, PostgreSQL RLS, pg-boss, Next.js, Node test runner.

**Spec:** `../02-specifications/capabilities-and-command-center.md` — “Notificações configuráveis”.

## Global Constraints

- User preferences are scoped to the authenticated actor and cannot be set for another actor.
- No preference can hide or remove approval work from the Inbox.
- Existing users with no saved preference retain current immediate delivery behavior.
- No channel is delivered unless its provider webhook is configured.

## Review Focus

- Cross-tenant reads/writes: RLS rejects data outside the caller scope.
- Cross-user updates: API derives actor ID only from authenticated context.
- Invalid channel/category/frequency values: reject with 400.
- Disabled categories/channels: no outbound delivery; report suppression clearly.
- Daily/weekly preferences: notifications coalesce by delivery window rather than sending once per event.

## Tasks

- [x] Add a pure preference validator/resolver with failing unit tests for defaults, selection, suppression, and invalid inputs.
- [x] Add the RLS-protected preference table, repository GET/UPSERT/clear, migration, and schema checks.
- [x] Add authenticated self-service GET/PUT/DELETE routes, actor isolation, and validation tests.
- [x] Add a durable notification outbox and pg-boss worker that coalesces selected notifications by actor/channel/category/window; unit and live tests cover daily/weekly scheduling and successful delivery.
- [x] Apply preferences to proposal and Runner-question notifications without changing Inbox visibility; tests cover configured and suppressed delivery paths.
- [x] Add Inbox preference controls and reset; verify through live API and worker.
- [x] Update capability, connector, API, and roadmap docs with implemented semantics and remaining provider setup requirements.
