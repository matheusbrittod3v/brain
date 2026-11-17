# Noema Onboarding Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize the approved Noema onboarding proposal as project documentation.

**Architecture:** Add a focused guide under `.brain/` and link it from the repository README. Keep database security details in the README and security architecture document as the source of truth.

**Tech Stack:** Markdown documentation.

**Spec:** Noema proposal `PROP-674eb6c2-b3af-4105-97ce-5d1db821787b`.

## Global Constraints

- Preserve existing local edits.
- Do not introduce unsupported component or command claims.
- Keep the guide concise and point to detailed sources.

## Review Focus

- Commands and paths must match the current repository layout.
- Database role and security instructions must continue to point to the authoritative README and security document.

---

### Task 1: Add onboarding guide and README entry

**Files:**
- Create: `noema/.brain/02-onboarding/guide.md`
- Modify: `noema/README.md`

- [x] Add the guide with project summary, monorepo map, documentation map, setup sequence, and change workflow.
- [x] Add a short “Documentation” section near the top of the README linking to the guide and key source documents.
- [x] Review links and commands against the current tree; no tests run for this documentation-only change.
