import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../dist/src/server.js";

function installAiWorkerStub(markdown) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    if (String(url).endsWith("/parse-document")) return Response.json({ markdown, engine: "docling" });
    if (String(url).endsWith("/redact-pii")) {
      const { text } = JSON.parse(init.body);
      return Response.json({ redacted_text: text.replaceAll("jane@example.test", "[EMAIL_REDACTED]") });
    }
    throw new Error(`Unexpected AI Worker URL: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("authenticated document ingestion parses, scans, redacts, persists, and audits extracted Markdown", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  process.env.AI_WORKER_URL = "http://ai-worker";
  const worker = installAiWorkerStub("# Synthetic policy\n\nContact jane@example.test about docling-fixture-731.");
  const audit = new InMemoryAuditLogger();
  const app = buildApp("document-test-key", ["document-project"], audit);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/document-project/ingest-document",
      headers: { authorization: "Bearer document-test-key" },
      payload: { fileName: "policy.docx", contentBase64: Buffer.from("synthetic docx bytes").toString("base64"), accessPolicyId: "internal-project" }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(worker.calls[0]?.url, "http://ai-worker/parse-document");
    assert.match(worker.calls[0]?.body ?? "", /policy\.docx/);
    assert.equal(response.json().item.sourceUri, ".brain/imported-documents/policy.docx.md");
    assert.equal(response.json().item.sourceOrigin, "external_reference");
    assert.equal(response.json().item.sourceKind, "api");
    assert.equal(response.json().item.trustLevel, "untrusted");
    assert.match(response.json().item.content, /\[EMAIL_REDACTED\]/);
    assert.doesNotMatch(response.json().item.content, /jane@example\.test/);
    assert.ok(audit.events.some((event) => event.targetType === "knowledge_item" && event.targetId === response.json().item.id));
    const search = await app.inject({
      method: "POST", url: "/v1/projects/document-project/search",
      headers: { authorization: "Bearer document-test-key" }, payload: { query: "docling-fixture-731" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.ok(search.json().items.some((item) => item.id === response.json().item.id));
  } finally {
    await app.close();
    worker.restore();
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});

test("document ingestion rejects extracted secrets before persistence", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  process.env.AI_WORKER_URL = "http://ai-worker";
  const worker = installAiWorkerStub("# Extracted\n\nAWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF");
  const app = buildApp("document-test-key", ["document-secret-project"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/projects/document-secret-project/ingest-document",
      headers: { authorization: "Bearer document-test-key" },
      payload: { fileName: "unsafe.pdf", contentBase64: Buffer.from("synthetic pdf bytes").toString("base64") }
    });
    assert.equal(response.statusCode, 422, response.body);
    const search = await app.inject({
      method: "POST", url: "/v1/projects/document-secret-project/search",
      headers: { authorization: "Bearer document-test-key" }, payload: { query: "Extracted" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().items.length, 0);
  } finally {
    await app.close();
    worker.restore();
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});

test("document ingestion rejects unsafe names before contacting the parser", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  process.env.AI_WORKER_URL = "http://ai-worker";
  const worker = installAiWorkerStub("# Must not be parsed");
  const app = buildApp("document-test-key", ["document-name-project"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/projects/document-name-project/ingest-document",
      headers: { authorization: "Bearer document-test-key" },
      payload: { fileName: "../policy.docx", contentBase64: Buffer.from("bytes").toString("base64") }
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(worker.calls.length, 0);
  } finally {
    await app.close();
    worker.restore();
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});

test("document ingestion fails closed when configured PII redaction is unavailable", async () => {
  const previousUrl = process.env.AI_WORKER_URL;
  const previousFetch = globalThis.fetch;
  process.env.AI_WORKER_URL = "http://ai-worker";
  globalThis.fetch = async (url) => String(url).endsWith("/parse-document")
    ? Response.json({ markdown: "# Synthetic contact\n\njane@example.test", engine: "docling" })
    : new Response("unavailable", { status: 503 });
  const app = buildApp("document-test-key", ["document-pii-fail-project"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/projects/document-pii-fail-project/ingest-document",
      headers: { authorization: "Bearer document-test-key" },
      payload: { fileName: "contact.pdf", contentBase64: Buffer.from("synthetic pdf").toString("base64") }
    });
    assert.equal(response.statusCode, 503, response.body);
    const search = await app.inject({
      method: "POST", url: "/v1/projects/document-pii-fail-project/search",
      headers: { authorization: "Bearer document-test-key" }, payload: { query: "Synthetic contact" }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.equal(search.json().items.length, 0);
  } finally {
    await app.close();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.AI_WORKER_URL;
    else process.env.AI_WORKER_URL = previousUrl;
  }
});
