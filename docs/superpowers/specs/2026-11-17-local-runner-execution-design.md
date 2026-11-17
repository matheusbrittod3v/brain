# Local Runner Execution Design

## Intent

Complete the documented local Runner path so a user can enqueue a task into the encrypted Edge database, start `brain runner up --local`, and inspect the resulting state and draft output.

## Goals

- Use the existing SQLite Edge task queue as the durable local source.
- Start the existing draft-only Runner daemon from the CLI and close it cleanly on SIGINT/SIGTERM.
- Persist task completion state, draft result, and reported model usage.
- Provide local enqueue and list commands so behavior can be observed without the Hub.
- Report only providers that have an implemented execution adapter as ready.

## Non-goals

- Implement cloud/provider adapters beyond the existing Ollama executor.
- Add cron scheduling, local MCP tools, or a full multi-step agent loop.
- Grant the Runner authority to execute commands, modify source files, or approve proposals.

## Approach

Use the existing Edge queue and `startRunnerDaemon` as the execution path. A small CLI adapter will map Edge task claim/complete methods to the Runner task-source interface. The Edge schema will add result and usage columns with a forward-compatible SQLite migration. The CLI will support `task enqueue --local`, `task list --local`, and a long-running `runner up --local` process with signal handling. Unsupported provider names will fail clearly instead of reporting readiness.

## Constraints and verification

- Preserve SQLCipher-required storage and existing keychain setup for CLI-created Edge databases.
- Preserve draft-only behavior and destructive-command escalation.
- Persist blocked destructive tasks with the explicit `escalated` state instead of `failed`.
- Test queue/result persistence and daemon behavior with a deterministic injected executor; run a real local Ollama task only if Ollama is available, without downloading a model unless explicitly configured with `--pull`.
