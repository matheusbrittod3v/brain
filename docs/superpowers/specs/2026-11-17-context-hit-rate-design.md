# Context Hit Rate — design

## Intent

Implement the normative Context Hit Rate end to end. Noema must know which knowledge items it sent in a client session and which of those items were read, cited, or connected to an edited path, so it can report `hits / items_sent` and improve retrieval from observed use.

## Goals

- Persist item delivery and hit evidence across API and worker restarts.
- Isolate records by trusted tenant, project, actor, and each item's access policy using PostgreSQL RLS.
- Make delivery and hit updates idempotent within a session.
- Return a session hit rate and use per-item session hit rates for retrieval scoring.
- Create or reinforce inferred `CO_ACCESSED_WITH` edges for pairs of hit items in a session; let the existing 60-day inferred-edge decay remove stale relations.

## Non-goals

- Store conversation text, prompts, or model outputs.
- Infer a session from actor identity or elapsed time.
- Treat an item ID supplied by a client as proof of delivery or access.
- Count an edit as evidence unless it names a task and matches an item already delivered in that session.

## Approaches

1. **Explicit client session ID with a durable item ledger — selected.** REST and MCP callers send an opaque `sessionId`; Noema scopes it to the authenticated tenant/project/actor and persists delivered items plus evidence under RLS. This supports concurrent sessions, retries, and restart-safe aggregation.
2. **Server-issued session token.** This avoids client-side ID creation but requires every REST/MCP client to retain and return a token across stateless requests. It adds protocol state without improving attribution over an explicit opaque ID.
3. **Infer sessions from actor and time window.** This needs little client change but merges concurrent IDEs, tasks, and browser sessions, making the metric incorrect.

## Selected behavior

- `sessionId` is a client-generated opaque string (1–128 characters, no control characters) and is required on operations that contribute to session feedback. The authenticated context supplies tenant, project, and actor; callers cannot choose those scope fields.
- Only Context Pack sources contribute to the metric; direct search results do not. Each delivered item is recorded once per `(tenant, project, actor, session, item)`, with its access policy, source URI, and optional task ID. Repeated delivery of the same item in the same session does not inflate the denominator.
- The denominator is the distinct delivered items visible under the caller's current RLS policy. The numerator is the distinct delivered items with at least one valid evidence type. Repeated evidence is idempotent.
- Read evidence comes from `brain_knowledge_get` with the same `sessionId`. Citation/use evidence comes from `brain_record_learning.usedItemIds`; only IDs already recorded as delivered to that session can count. Edit evidence comes from `editedPaths` plus a `taskId`; the path must match a source URI already delivered for that same task and session, and the authenticated actor must hold the active task lease.
- `brain_record_learning` returns the updated session rate. `CO_ACCESSED_WITH` is added in both directions when a second item in the session becomes a hit, pairing it with already-hit items. Repeated evidence reinforces inferred edge confidence and refreshes its age; deterministic edges are unaffected. Existing memory decay removes inferred edges after 60 days without reinforcement.
- Aggregate item ranking uses `context hit sessions / context delivery sessions`, normalized to `[0,1]`; items without Context Pack deliveries receive a zero hit-rate boost. Existing `knowledge_items.hit_count` remains a legacy direct-feedback counter and is not interpreted as a session count or used for this ranking.
- REST `/context` exposes the session ID used to record its sources. MCP `brain_context_build`, `brain_knowledge_get`, and `brain_record_learning` accept the same ID. Direct search (`/search`, `brain_search`) does not enter the normative Context Pack denominator. The web client keeps one ID for its active interaction session and sends it through context, read, and feedback calls.

## Constraints

- Do not trust tenant, project, actor, policy, delivered item IDs, or edited paths supplied without revalidating them against authenticated context and persisted session delivery.
- Record multi-item sends and hit updates transactionally; reject unauthorized IDs as an all-or-nothing operation.
- Preserve evidence type and task linkage for auditability; do not store response text.
- Update migrations, schema snapshots, API/MCP capability docs, and roadmap status with actual verification evidence.

## Open implementation details

- Use a `context_session_items` table with one row per delivered session/item, policy-aware RLS, `sent_at`, `hit_at`, `hit_evidence[]`, `source_uri`, and optional `task_id`.
- Add separate `context_sent_count` and `context_hit_count` counters for durable, indexed retrieval scoring; preserve legacy `hit_count` history without treating it as session data.
- Keep the public `ContextPack` unchanged except for the session feedback metadata returned by transport handlers; persist its selected `sources` after the pack is assembled.

