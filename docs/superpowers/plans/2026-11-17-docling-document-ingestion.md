# Docling Document Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ingest authenticated PDF/Office/HTML/spreadsheet uploads through Docling, then run the existing Noema security and persistence gates.

**Architecture:** The Hub accepts a bounded base64 upload and asks the existing AI Worker to parse it. The AI Worker validates the filename/extension and bytes, writes only to a temporary directory, runs Docling, and removes temporary files. The Hub scans the extracted Markdown with Gitleaks, applies configured PII redaction, enforces policy/OPA, persists and audits the resulting item, then queues embeddings through the existing mechanism.

**Tech Stack:** Fastify/TypeBox, Python FastAPI, Docling, Gitleaks, existing PostgreSQL/RLS repositories.

**Spec:** `docs/superpowers/specs/2026-11-17-docling-document-ingestion-design.md`

## Global Constraints

- Do not accept filesystem paths from request payloads.
- Accept only `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.html`, `.htm`, `.csv`; legacy binary Office formats are excluded because the image does not install LibreOffice.
- Maximum raw file size is 16 MiB; Hub request body limit is 24 MiB.
- Gitleaks must scan extracted content and fail closed before any persistence.
- Uploaded content must remain `draft`, `external_reference`, `api`, and `untrusted` through persistence.
- Both parsers absent/failing or configured PII redaction failure must prevent persistence; MarkItDown is the fallback when Docling is absent/fails.
- Never store temporary upload files after the conversion request.

## Review Focus

- Traversal and shell/path injection via filenames: test rejection before temporary write.
- Invalid or falsely declared base64 and oversized data: test explicit 4xx behavior without invoking Docling.
- Malicious or unsupported files and both parsers unavailable: test fail closed/no item.
- Secrets visible only after extraction: test that Gitleaks rejects extracted output before upsert.
- PII in extracted text: test configured redaction before persisted content and embedding.

---

### Task 1: Safe upload-based AI Worker parser

**Files:**
- Modify: `apps/ai-worker/main.py`
- Test: `apps/ai-worker/test_main.py`

**Interface:** `DocumentPayload(file_name: str, content_base64: str)`; `POST /parse-document` returns `{markdown, engine:"docling"|"markitdown"}`. Prefer Docling and fall back to MarkItDown. Inject converter instances for tests. Validate extension, strict base64, non-empty bytes, and 16 MiB raw cap; write to a unique temporary directory and clean it in `finally`.

- [ ] Add tests for supported/unsupported extensions, invalid/oversized bytes, temporary file suffix/contents, Docling success, MarkItDown fallback, both-parser failure, and cleanup.
- [ ] Run Python tests and observe expected failures.
- [ ] Implement validation and safe temporary conversion.
- [ ] Run Python tests and confirm all paths.

### Task 2: Authenticated Hub ingestion route

**Files:**
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/document-ingest.test.mjs`

**Interface:** `POST /v1/projects/:projectId/ingest-document` receives `{fileName, contentBase64, accessPolicyId?}`. Require configured `AI_WORKER_URL`; send bytes to `/parse-document`; use generated Markdown as content. Run Gitleaks before PII redaction; persist using a normalized `.brain/imported-documents/*.md` source URI and requested policy; apply OPA; audit and enqueue embedding like `/ingest`.

- [ ] Add authenticated route tests using a local synthetic AI Worker stub; verify Markdown extraction, policy scope, persisted item, audit and embedding job.
- [ ] Add rejection tests for unsupported name, secret in extracted Markdown, both parsers unavailable and PII redaction failure; assert no item persists.
- [ ] Run API tests and observe the new route failures.
- [ ] Implement the route with 24 MiB Fastify body limit and bounded response validation.
- [ ] Run API tests and typecheck.

### Task 3: Live Noema document ingestion and documentation

**Files:**
- Modify: `tests/integration/postgres-api-context-live.test.mjs` or create `tests/integration/postgres-document-ingest-live.test.mjs`
- Modify: `docs/04-roadmap/implementation-roadmap.md`, `docs/04-roadmap/local-dev-and-stack.md`

- [ ] Use a synthetic DOCX/PDF fixture and an isolated Docling service to ingest against PostgreSQL; assert sanitized persisted Markdown, source URI, policy, audit and no raw PII/secret.
- [ ] Record Docling's supported formats, the 16 MiB cap, and the live validation evidence; leave OCR quality and non-macOS host matrix as explicit open validation.
- [ ] Run relevant API, worker and full workspace typechecks.
