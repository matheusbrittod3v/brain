import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { buildApp } from "../../apps/api/dist/src/server.js";

const rootUrl = process.env.BRAIN_INTEGRATION_DB_URL;

test("live document ingestion stores only extracted/redacted Docling Markdown with policy and audit", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.BRAIN_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const projectId = `docling-live-${randomUUID()}`;
  const itemUri = ".brain/imported-documents/contract.docx.md";
  const itemId = itemUri;
  const previous = {
    databaseUrl: process.env.DATABASE_URL,
    databaseSystemUrl: process.env.DATABASE_SYSTEM_URL,
    pgStores: process.env.BRAIN_PG_STORES,
    pgBoss: process.env.BRAIN_PG_BOSS,
    aiWorkerUrl: process.env.AI_WORKER_URL,
    fetch: globalThis.fetch
  };
  process.env.DATABASE_URL = appUrl;
  delete process.env.DATABASE_SYSTEM_URL;
  process.env.BRAIN_PG_STORES = "1";
  process.env.BRAIN_PG_BOSS = "0";
  process.env.AI_WORKER_URL = "http://synthetic-docling";
  const rawMarker = `private-docling-fixture-${randomUUID()}`;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/parse-document")) {
      return Response.json({ markdown: `# Extracted contract\n\n${rawMarker} jane@example.test`, engine: "docling" });
    }
    if (String(url).endsWith("/redact-pii")) {
      const { text } = JSON.parse(init.body);
      return Response.json({ redacted_text: text.replaceAll("jane@example.test", "[EMAIL_REDACTED]") });
    }
    throw new Error(`Unexpected synthetic AI Worker URL: ${url}`);
  };
  const app = buildApp("docling-live-api-key", [projectId], undefined, undefined, undefined, undefined, undefined, ["internal-project"]);
  try {
    await admin`INSERT INTO organizations (id, name) VALUES ('default-org', 'Brain Docling Integration') ON CONFLICT DO NOTHING`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, 'default-org', 'Synthetic Docling Project')`;
    const response = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/ingest-document`,
      headers: { authorization: "Bearer docling-live-api-key" },
      payload: { fileName: "contract.docx", contentBase64: Buffer.from("synthetic docx bytes").toString("base64") }
    });
    assert.equal(response.statusCode, 200, response.body);
    const [stored] = await admin`
      SELECT id, source_uri, status, access_policy_id, source_origin, source_kind, trust_level, metadata, content, content_hash
      FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${itemId}
    `;
    assert.ok(stored);
    assert.equal(stored.source_uri, itemUri);
    assert.equal(stored.status, "draft");
    assert.equal(stored.access_policy_id, "internal-project");
    assert.equal(stored.source_origin, "external_reference");
    assert.equal(stored.source_kind, "api");
    assert.equal(stored.trust_level, "untrusted");
    assert.equal(stored.metadata.source, "document_upload");
    assert.equal(stored.metadata.extractionEngine, "docling");
    assert.match(stored.content, new RegExp(rawMarker));
    assert.match(stored.content, /\[EMAIL_REDACTED\]/);
    assert.doesNotMatch(stored.content, /jane@example\.test/);
    const versions = await admin`SELECT count(*)::int AS count FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND item_id = ${itemId}`;
    assert.equal(versions[0].count, 1);
    const audits = await admin`SELECT action, target_type, target_id, access_policy_id FROM audit_logs WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND target_id = ${itemId}`;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].target_type, "knowledge_item");
    assert.equal(audits[0].access_policy_id, "internal-project");
  } finally {
    await app.close();
    await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM sync_changes WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM audit_logs WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM projects WHERE tenant_id = 'default-org' AND id = ${projectId}`;
    await admin.end();
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.databaseSystemUrl === undefined) delete process.env.DATABASE_SYSTEM_URL; else process.env.DATABASE_SYSTEM_URL = previous.databaseSystemUrl;
    if (previous.pgStores === undefined) delete process.env.BRAIN_PG_STORES; else process.env.BRAIN_PG_STORES = previous.pgStores;
    if (previous.pgBoss === undefined) delete process.env.BRAIN_PG_BOSS; else process.env.BRAIN_PG_BOSS = previous.pgBoss;
    if (previous.aiWorkerUrl === undefined) delete process.env.AI_WORKER_URL; else process.env.AI_WORKER_URL = previous.aiWorkerUrl;
    globalThis.fetch = previous.fetch;
  }
});
