# Project Autodiscovery and SCIP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `brain init` inspect a repository and write reviewable inferred drafts, with optional ingestion of real SCIP protobuf indexes and opt-in official SCIP indexers.

**Architecture:** Keep the existing deterministic source scan as the baseline. Decode official SCIP protobuf using `@scip-code/scip` and enrich discovery only when a valid index exists; never represent heuristic symbols as compiler-backed SCIP. `brain init --scip` may invoke the official TypeScript or Python indexer explicitly, while ordinary init remains local and fast. Write draft artifacts only when their destination does not already exist.

**Tech Stack:** TypeScript, Node.js, `web-tree-sitter`/existing AST extractors, official SCIP protobuf TypeScript bindings, Sourcegraph SCIP indexer CLIs.

**Spec:** `docs/04-roadmap/implementation-roadmap.md` §Fase 2; `docs/02-specifications/capabilities-and-command-center.md` §Project Autodiscovery; `docs/04-roadmap/open-source-building-blocks.md` §Sourcegraph SCIP.

## Global Constraints

- Deterministic evidence has `confidence: 1.0` and `isInferred: false`.
- Inferred knowledge artifacts stay `status: draft` and `isInferred: true` until human review.
- `brain init` must not overwrite existing user files.
- External SCIP indexers run only when explicitly requested with `--scip`.
- Missing or invalid SCIP data must retain deterministic discovery and report the SCIP state accurately.

## Review Focus

- Binary `.scip` files are protobuf, not JSON: verify official decoding and definition/reference roles.
- Indexers may be absent, fail, or emit no index: verify explicit errors for `--scip` and deterministic fallback otherwise.
- Existing `.brain` drafts may be user-edited: verify repeated `brain init` leaves their bytes unchanged.
- Arbitrary repositories may contain symlinks, generated folders, and large/non-source files: verify scanning remains bounded to supported source/config files and skips symlinks.
- Invalid IDs or markdown/frontmatter values may break generated drafts: verify YAML-safe serialization and deterministic filenames.

---

### Task 1: Decode actual SCIP indexes

**Files:** `packages/code-intelligence/src/index.ts`, `packages/code-intelligence/package.json`, `packages/code-intelligence/test/scip.test.ts`.

**Interfaces:** `parseScipIndex(input: Uint8Array | string): ScipIndex` decodes actual protobuf bytes and preserves a JSON fixture compatibility path. `runExternalScipIndexer(projectDir, language, outputFile?)` runs the official language CLI and returns the resolved artifact path. Add `ScipOccurrence.role` as definition/reference derived from SCIP `symbolRoles`.

- [x] Test a protobuf fixture with one definition and one reference; assert normalized relative paths, symbol IDs, ranges, and roles.
- [x] Test malformed protobuf/JSON rejection and CLI command/arguments/output handling.
- [x] Implement decoding using the official TypeScript SCIP schema and correct CLI-specific arguments.
- [x] Run `npm --workspace=@noema/code-intelligence test` and typecheck.

### Task 2: Feed SCIP into project discovery

**Files:** `packages/project-discovery/src/index.ts`, `packages/project-discovery/test/discovery.test.ts`.

**Interfaces:** `discoverDeterministic(projectRoot, options?)` accepts an optional decoded SCIP index. Its result adds normalized SCIP definitions/references while preserving all existing deterministic AST, dependency, route, SQL, and anchor fields. Without SCIP, the field is empty and confidence remains explicit.

- [x] Test that a definition/reference index enriches a synthetic project and that missing/invalid index falls back to the current deterministic report.
- [x] Implement index discovery at `index.scip` and `.scip/index.scip`, plus optional indexer invocation requested by init.
- [x] Run `npm --workspace=@noema/project-discovery test` and typecheck.

### Task 3: Make `brain init` materialize reviewable drafts

**Files:** `apps/cli/src/commands.ts`, `apps/cli/src/index.ts`, `apps/cli/package.json`, `apps/cli/test/cli.test.ts`, `packages/knowledge/src/index.ts`, `packages/knowledge/test/knowledge.test.ts`.

**Interfaces:** `runInit(rootDir, projectId?)` returns the deterministic report summary and generated/skipped draft paths; `runInitWithScip(rootDir, projectId?, indexer?)` selects and invokes the available SCIP indexer before calling init. The CLI accepts `brain init [projectId] [--scip]`. Generated drafts use YAML-safe frontmatter from `KnowledgeItem` metadata and are written only when absent. `parseKnowledgeFile` must preserve frontmatter `confidence`, `is_inferred`, and `trust_level` values so generated artifacts remain drafts when ingested.

- [x] Test a synthetic TS/SQL project produces overview/business/architecture drafts, `--scip` invokes the chosen indexer, and repeat init preserves edited bytes.
- [x] Implement CLI wiring and safe artifact materialization.
- [x] Run CLI tests/typecheck and build all affected workspaces.

### Task 4: Update roadmap evidence

**Files:** `docs/04-roadmap/implementation-roadmap.md`, `docs/02-specifications/capabilities-and-command-center.md`, `docs/04-roadmap/open-source-building-blocks.md`.

- [x] Record what `brain init` and SCIP now do, the explicit indexer requirement, and remaining unsupported areas.
- [x] Verify the docs no longer describe generated heuristic occurrences as real SCIP.

### Follow-up Task 5: Respect repository ignore rules

**Files:** `packages/project-discovery/src/index.ts`, `packages/project-discovery/test/discovery.test.ts`, `packages/project-discovery/package.json`.

**Interface:** `runProjectAutodiscovery` excludes files ignored by root and nested `.gitignore` files while preserving negated exceptions and existing hard safety exclusions. No Git repository initialization or mutation is allowed.

- [x] Add a synthetic repository test covering ignored build output, ignored source, negation, and nested ignore rules.
- [x] Implement `.gitignore` matching using the maintained `ignore` package and retain symlink/hard-exclusion behavior.
- [x] Build and run discovery tests, then record the behavior in the roadmap and capability docs.

### Follow-up Task 6: Integrate Tree-sitter into autodiscovery

**Files:** `packages/code-intelligence/src/index.ts`, `packages/code-intelligence/package.json`, `packages/project-discovery/src/index.ts`, `packages/project-discovery/package.json`, `packages/project-discovery/test/discovery.test.ts`, `apps/cli/src/commands.ts`, `apps/cli/src/index.ts`, and affected CLI tests.

**Interface:** Project discovery becomes async so it can load local WASM grammars through `web-tree-sitter`. Load bundled Python, Go, Java, and Rust grammars; keep TypeScript/JavaScript on the existing compiler AST. Keep route/dependency/anchor extraction, `.gitignore`, symlink rejection, and SCIP independent. If a grammar fails to load or the syntax tree has errors, use the current deterministic extractor for that file and report its path.

- [x] Add a failing discovery test showing a declaration inside a Python multiline string is not returned as a symbol.
- [x] Load bundled grammars once per discovery run, reuse parsers, dispose parsers after scanning, and report which grammars were active.
- [x] Convert discovery and `brain init` call paths to async; retain write-if-missing and explicit SCIP behavior.
- [x] Test malformed code/fallback, parser cleanup, language coverage, and the real CLI on a temporary project.
- [x] Run focused tests, full workspace typecheck, and record the actual grammar package footprint/remaining limitations in docs.

### Follow-up Task 7: Discover test and infrastructure files

**Files:** `packages/project-discovery/src/index.ts`, `packages/project-discovery/test/discovery.test.ts`, `apps/cli/src/commands.ts`, `apps/cli/test/cli.test.ts`, and the autodiscovery roadmap/capability docs.

**Interface:** The deterministic report adds sorted `testFiles` and `infrastructureFiles` paths. Test classification uses standard test naming conventions and test directory names, with Rust inline test attributes. Infrastructure classification covers container manifests, CI workflows, Terraform/HCL, and Kubernetes/Helm paths. Ignored files remain excluded. When either list is non-empty, autodiscovery emits one inferred code-map draft; CLI JSON reports both counts.

- [x] Add failing discovery tests for representative test and infrastructure files and ignored-file exclusion.
- [x] Implement deterministic path/content classification and generated draft metadata.
- [x] Add CLI assertions for the counts and draft materialization.
- [x] Run discovery/CLI suites and workspace typecheck; update docs and progress ledger.

### Follow-up Task 8: Preserve SCIP symbol relationships

**Files:** `packages/code-intelligence/src/index.ts`, SCIP and project-discovery tests, autodiscovery docs.

**Interface:** Preserve `Document.symbols`, symbol display metadata/documentation/enclosing symbol, and every SCIP relationship flag in the normalized index. Materialize the semantic relations in the inferred SCIP draft (bounded preview with total counts). Do not persist graph edges until identity resolution and RLS-scoped item mapping are defined.

- [x] Add failing protobuf parser assertions for symbol metadata and relationship flags.
- [x] Add discovery assertions for SCIP symbol and IMPLEMENTS relationship draft output.
- [x] Preserve the official SCIP fields and render a bounded semantic map.
- [x] Run parser/discovery suites and exercise `brain init` with a protobuf index.

### Follow-up Task 9: Persist local SCIP relationships in the Knowledge Graph

**Files:** `packages/code-intelligence/src/index.ts`, `packages/graph/src/index.ts`, `apps/worker/src/index.ts`, unit tests, autodiscovery docs.

**Interface:** Resolve SCIP symbol owners to source document paths, then resolve those paths to already persisted KnowledgeItems during local repository ingestion. Persist grouped `IMPLEMENTS`/`DEPENDS_ON` edges under the same tenant/project and each endpoint's policy. Store SCIP symbol mappings and exact relationship flags as relation metadata, with the index path as evidence. Skip unavailable endpoints.

- [x] Add a deterministic SCIP symbol-to-document edge mapping and tests.
- [x] Persist relation evidence URI and metadata through the graph store without bypassing its RLS checks.
- [x] Add worker ingestion coverage for two related code files.
- [x] Run SCIP/graph/worker suites and document local-only scope plus remote-index gap.

### Follow-up Task 10: Persist source-backed SCIP symbols and read remote indexes

**Files:** `integrations/github/src/index.ts`, `integrations/github/test/github.test.ts`, `packages/code-intelligence/src/index.ts`, SCIP tests, `apps/worker/src/index.ts`, worker tests, autodiscovery docs.

**Interface:** The GitHub connector preserves `.scip/index.scip` and `index.scip` bytes as base64 instead of lossy UTF-8, with a separate 16 MiB cap. The worker parses local or remote indexes, creates deterministic `code_symbol` KnowledgeItems only for SCIP definitions that have a matching persisted source file and definition occurrence, sanitizes their documentation, inherits source trust/status/policy, and records file/symbol relationships under the graph's existing RLS contract.

- [x] Add tests for definition-backed symbol extraction and remote protobuf-byte preservation.
- [x] Ingest remote index paths through full snapshots and incremental GitHub comparisons while keeping them out of ordinary text ingestion.
- [x] Persist symbol KnowledgeItems with deterministic IDs, file/range metadata, source provenance, policy inheritance, secret scanning and PII redaction.
- [x] Create file-to-symbol and symbol-to-symbol graph links when a graph store is configured; keep symbol items available when graph writing is disabled.
- [x] Verify code-intelligence, GitHub connector and worker suites; update the roadmap and capability matrix.
- [x] Run the PostgreSQL live worker integration: two symbol items and four evidenced SCIP edges persisted under RLS, then verify cleanup.
- [x] Preserve GraphEdge metadata as a JSONB object (not a JSON string); the live query confirmed `metadata->>'source'` is usable.

### Follow-up Task 11: Reconcile removed SCIP symbols and edges

**Files:** `packages/database/src/repositories.ts`, `packages/graph/src/index.ts`, `apps/worker/src/index.ts`, worker/graph tests and PostgreSQL live integration.

**Interface:** After a complete, safe index pass, retire source-backed SCIP symbol items absent from the new index, remove their embeddings/relations, and atomically replace graph edges evidenced by that SCIP index. Keep previous state if any required source, secret scan, parsing, persistence, or audit step fails; a relation-write error must roll back both old-edge deletion and new-edge insertion.

- [x] Reconcile removed symbols within tenant/project/repository scope and delete their embeddings and attached relations.
- [x] Replace SCIP evidence edges in one RLS transaction only after safe processing; keep source-repository separation and RLS authorization.
- [x] Verify authorized scope and transaction grouping in graph tests; verify the full replacement behavior during the PostgreSQL live reindex.
- [x] Exercise reindexing against PostgreSQL: remove one of two symbols, confirm one active symbol and only the surviving edge remains.
- [x] Run graph/worker tests and workspace typecheck.
