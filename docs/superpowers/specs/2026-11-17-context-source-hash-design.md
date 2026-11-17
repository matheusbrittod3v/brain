# Context Source Hash Design

## Intent

Complete the normative `edit` evidence for Context Hit Rate by discovering source-file changes between Context Pack delivery and task feedback. Clients should not have to invent an `editedPaths` list, and pre-existing edits must not count as edits made in the session.

## Chosen approach

At Context Pack delivery, hash each returned `sourceUri` that resolves to an existing regular file inside the configured project workspace. Persist only the SHA-256 digest with the actor/project/session/item ledger row. At task feedback, compare current hashes to those first-delivery hashes and use changed source URIs as edit evidence. A missing file after delivery counts as changed; remote URIs, paths outside the workspace, symlinks escaping the workspace, and unavailable files have no baseline and cannot produce automatic edit evidence.

This is preferred to a Git-base snapshot because it works without Git, excludes unrelated files, and does not mistake edits made before Context Pack delivery for session edits. It stores digests rather than source contents. Hashes remain first-delivery metadata when a session repeats a pack.

## Behavior and safety

- Workspace root is selected by project mapping (`NOEMA_PROJECT_WORKSPACE_ROOTS`) and falls back to `NOEMA_WORKSPACE_ROOT` / the existing MCP runtime root.
- Paths are resolved and realpath-checked under that root before reading; no symlink or traversal may escape it.
- Automatic evidence is limited to files whose source URI was delivered in the same tenant/project/actor/session and whose row carries the same task ID.
- The repository validates and locks the same actor's unexpired lease in the transaction that records evidence.
- Optional caller `editedPaths` remain hints only: they can restrict reporting, but a path produces a hit only when workspace hashing confirms it changed after delivery and the exact URI/task was delivered.
- Matching changes are idempotent. Unmatched, unchanged, unhashable, remote, and out-of-workspace paths are reported as warnings and do not count as hits.
- Empty source lists and workspaces without eligible files return an empty diff without failing Context Pack construction.

## Acceptance

1. An unchanged source has identical baseline/current hashes and does not produce a hit.
2. A source changed after Context Pack delivery is discovered without caller-supplied paths and counts only under the same task and active actor lease.
3. An edit already present at Context Pack delivery is baseline state and does not count.
4. Traversal paths, external URIs, and symlinks outside the workspace are never read or credited.
5. Repeated Context Pack delivery and edit feedback preserve first-delivery baseline and remain idempotent.
6. REST, MCP, PostgreSQL migration, cache invalidation, and API warnings remain consistent.

## Explicit limitation

Automatic discovery covers local workspace files exposed by `sourceUri`. Sources that are remote, generated elsewhere, or not present in the configured workspace require another explicit evidence source and remain untracked by automatic file hashing.
