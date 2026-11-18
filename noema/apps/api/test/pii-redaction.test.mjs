import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { redactPiiWithAiWorker } from "../dist/src/server.js";
import { buildApp } from "../dist/src/server.js";

test("optional PII redaction preserves text when the AI Worker is not configured", async () => {
  let called = false;
  const text = await redactPiiWithAiWorker("synthetic contact jane@example.test", undefined, async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  assert.equal(text, "synthetic contact jane@example.test");
  assert.equal(called, false);
});

test("configured PII redaction returns the worker's sanitized text", async () => {
  const result = await redactPiiWithAiWorker("synthetic contact jane@example.test", "http://ai-worker", async (url, init) => {
    assert.equal(String(url), "http://ai-worker/redact-pii");
    assert.match(String(init?.body), /jane@example\.test/);
    return new Response(JSON.stringify({ redacted_text: "synthetic contact [EMAIL_REDACTED]" }), { status: 200 });
  });
  assert.equal(result, "synthetic contact [EMAIL_REDACTED]");
});

test("configured PII redaction fails closed on HTTP and malformed worker responses", async () => {
  await assert.rejects(
    redactPiiWithAiWorker("sensitive content", "http://ai-worker", async () => new Response("unavailable", { status: 503 })),
    /PII redaction failed: HTTP 503/
  );
  await assert.rejects(
    redactPiiWithAiWorker("sensitive content", "http://ai-worker", async () => new Response(JSON.stringify({ message: "no redacted field" }), { status: 200 })),
    /PII redaction response is missing redacted_text/
  );
});

test("project ingestion persists sanitized content when PII redaction is configured", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  const previousFetch = globalThis.fetch;
  process.env.AI_WORKER_URL = "http://ai-worker";
  globalThis.fetch = async (_url, init) => {
    const { text } = JSON.parse(init.body);
    return Response.json({ redacted_text: text.replace("jane@example.test", "[EMAIL]") });
  };
  const app = buildApp("test-secret-key", ["pii-project"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/pii-project/ingest",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { filePath: "notes.txt", content: "synthetic contact jane@example.test" }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.json().warnings.join(" "), /sanitizados/);
    const search = await app.inject({
      method: "POST",
      url: "/v1/projects/pii-project/search",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { query: "synthetic" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.doesNotMatch(search.body, /jane@example\.test/);
    assert.match(search.body, /\[EMAIL\]/);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});

test("project ingestion does not persist content when configured PII redaction is unavailable", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  const previousFetch = globalThis.fetch;
  process.env.AI_WORKER_URL = "http://ai-worker";
  globalThis.fetch = async () => { throw new Error("worker unavailable"); };
  const app = buildApp("test-secret-key", ["pii-fail-closed"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/pii-fail-closed/ingest",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { filePath: "notes.txt", content: "synthetic contact jane@example.test" }
    });
    assert.equal(response.statusCode, 503, response.body);
    const search = await app.inject({
      method: "POST",
      url: "/v1/projects/pii-fail-closed/search",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { query: "synthetic" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.doesNotMatch(search.body, /jane@example\.test/);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});

test("Edge sync push scans raw drafts and persists a redacted title and body", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  const previousFetch = globalThis.fetch;
  process.env.AI_WORKER_URL = "http://ai-worker";
  globalThis.fetch = async (_url, init) => {
    const { text } = JSON.parse(init.body);
    return Response.json({ redacted_text: text.replaceAll("jane@example.test", "[EMAIL]") });
  };
  const app = buildApp("test-secret-key", ["pii-sync"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/sync/push",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { projectId: "pii-sync", drafts: [{ id: "PII-DRAFT", title: "Ticket jane@example.test", content: "Contact jane@example.test" }] }
    });
    assert.equal(response.statusCode, 200, response.body);
    const search = await app.inject({
      method: "POST", url: "/v1/projects/pii-sync/search",
      headers: { authorization: "Bearer test-secret-key" }, payload: { query: "Contact" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.doesNotMatch(search.body, /jane@example\.test/);
    assert.match(search.body, /\[EMAIL\]/);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});
