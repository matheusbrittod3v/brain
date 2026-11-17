import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildApp } from "../../apps/api/dist/src/server.js";

const rootUrl = process.env.NOEMA_INTEGRATION_DB_URL;

test("live API ingest is searchable and cited by Context Pack with a durable version and audit row", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.NOEMA_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const projectId = `api-context-${randomUUID()}`;
  const itemId = `API-CONTEXT-${randomUUID()}`;
  const sessionId = `api-session-${randomUUID()}`;
  const taskId = `edit-task-${randomUUID()}`;
  const marker = `api-context-live-${randomUUID()}`;
  const sourceUri = `.brain/04-engineering/${itemId}.md`;
  const workspaceRoot = mkdtempSync(join(tmpdir(), "noema-api-context-workspace-"));
  const workspaceSource = join(workspaceRoot, sourceUri);
  mkdirSync(dirname(workspaceSource), { recursive: true });
  writeFileSync(workspaceSource, "baseline source version");
  const previousEnv = {
    databaseUrl: process.env.DATABASE_URL,
    databaseSystemUrl: process.env.DATABASE_SYSTEM_URL,
    pgStores: process.env.NOEMA_PG_STORES,
    pgBoss: process.env.NOEMA_PG_BOSS,
    projectWorkspaceRoots: process.env.NOEMA_PROJECT_WORKSPACE_ROOTS,
    workspaceRoot: process.env.NOEMA_WORKSPACE_ROOT
  };
  process.env.DATABASE_URL = appUrl;
  delete process.env.DATABASE_SYSTEM_URL;
  process.env.NOEMA_PG_STORES = "1";
  process.env.NOEMA_PG_BOSS = "0";
  process.env.NOEMA_PROJECT_WORKSPACE_ROOTS = JSON.stringify({ [projectId]: workspaceRoot });
  const queryVector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
  let embeddedQueries = 0;
  const app = buildApp(
    "postgres-api-context-live-key",
    [projectId],
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ available: true }),
    ["internal-project"],
    async (query) => {
      embeddedQueries += 1;
      if (query === marker) throw new Error("synthetic Ollama outage");
      return queryVector;
    }
  );
  const headers = { authorization: "Bearer postgres-api-context-live-key" };

  try {
    await admin`INSERT INTO organizations (id, name) VALUES ('default-org', 'Noema API Context Integration') ON CONFLICT DO NOTHING`;
    const ingest = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/ingest`,
      headers,
      payload: {
        filePath: sourceUri,
        content: `---\nid: ${itemId}\ntitle: API Context Integration ${itemId}\ntype: architecture_decision\nstatus: approved\naccess_policy: internal-project\n---\n\n${marker} Synthetic record for live API, SQL retrieval, and Context Pack verification.`
      }
    });
    assert.equal(ingest.statusCode, 200, ingest.body);
    assert.ok(ingest.json().warnings.some((warning) => warning.includes("Embeddings vetoriais")));

    const [storedItem] = await admin`
      SELECT source_version FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${itemId}
    `;
    const vectorLiteral = `[${queryVector.join(",")}]`;
    await admin`
      INSERT INTO knowledge_embeddings (
        tenant_id, project_id, knowledge_item_id, source_version, chunk_index,
        chunk_text, access_policy_id, embedding_model, embedding
      ) VALUES (
        'default-org', ${projectId}, ${itemId}, ${storedItem.source_version}, 0,
        'durable architecture and authorization evidence', 'internal-project', 'bge-m3', ${vectorLiteral}::vector
      )
    `;

    const generatedSessionContext = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/context`, headers,
      payload: { task: "empty domain session generation", includeDomains: [11], tokenBudget: 300 }
    });
    assert.equal(generatedSessionContext.statusCode, 200, generatedSessionContext.body);
    assert.match(generatedSessionContext.json().sessionId, /^[0-9a-f-]{36}$/i, "REST generates an opaque session ID when omitted");
    assert.deepEqual(generatedSessionContext.json().hitRate, {
      sessionId: generatedSessionContext.json().sessionId, hits: 0, itemsSent: 0, rate: 0
    });

    const semanticSearch = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/search`,
      headers,
      payload: { query: "helium orchard telescope", limit: 5 }
    });
    assert.equal(semanticSearch.statusCode, 200, semanticSearch.body);
    assert.ok(semanticSearch.json().items.some((item) => item.id === itemId), "API search uses the query vector when FTS has no lexical match");
    assert.ok(embeddedQueries > 0, "the configured provider receives the search query");

    const mcpSearch = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "brain_search", arguments: { projectId, query: "helium orchard telescope", limit: 5 } }
      }
    });
    assert.equal(mcpSearch.statusCode, 200, mcpSearch.body);
    const mcpSearchEvent = mcpSearch.body.split(/\r?\n/).find((line) => line.startsWith("data: "));
    assert.ok(mcpSearchEvent, "MCP search returns a Streamable HTTP result event");
    const mcpSearchPayload = JSON.parse(mcpSearchEvent.slice("data: ".length));
    const mcpSearchResult = JSON.parse(mcpSearchPayload.result.content[0].text);
    assert.ok(mcpSearchResult.items.some((item) => item.id === itemId), "brain_search uses query vectors when FTS has no match");

    const lexicalFallback = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/search`,
      headers,
      payload: { query: marker, limit: 5 }
    });
    assert.equal(lexicalFallback.statusCode, 200, lexicalFallback.body);
    assert.ok(lexicalFallback.json().items.some((item) => item.id === itemId), "provider failure leaves lexical search available");

    const search = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/search`,
      headers,
      payload: { query: marker, limit: 5 }
    });
    assert.equal(search.statusCode, 200, search.body);
    assert.ok(search.json().items.some((item) => item.id === itemId), "SQL search returns the ingested item");

    const context = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/context`,
      headers,
      payload: { task: "helium orchard telescope", intent: "onboarding", includeDomains: [4], tokenBudget: 1200, sessionId, taskId }
    });
    assert.equal(context.statusCode, 200, context.body);
    assert.ok(context.json().sources.some((source) => source.id === itemId), "Context Pack cites the SQL item");
    assert.deepEqual(context.json().hitRate, { sessionId, hits: 0, itemsSent: 1, rate: 0 });
    const [{ source_hash: firstSourceHash }] = await admin`
      SELECT source_hash FROM context_session_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND session_id = ${sessionId} AND item_id = ${itemId}
    `;
    assert.equal(firstSourceHash, createHash("sha256").update("baseline source version").digest("hex"));

    const untrackedFeedback = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers,
      payload: { query: marker, rating: "useful", sessionId: `${sessionId}-wrong`, itemIds: [itemId] }
    });
    assert.equal(untrackedFeedback.statusCode, 404, "direct search or an unregistered item cannot be credited as Context Pack evidence");

    const ordinaryRead = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/knowledge/${itemId}`, headers });
    assert.equal(ordinaryRead.statusCode, 200, ordinaryRead.body);
    const [{ hit_at: ordinaryReadHitAt }] = await admin`
      SELECT hit_at FROM context_session_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND session_id = ${sessionId} AND item_id = ${itemId}
    `;
    assert.equal(ordinaryReadHitAt, null, "a knowledge read without sessionId does not count as a hit");

    const read = await app.inject({
      method: "GET", url: `/v1/projects/${projectId}/knowledge/${itemId}?sessionId=${encodeURIComponent(sessionId)}`, headers
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().item.id, itemId, "session-linked knowledge read records evidence");

    const feedback = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers,
      payload: { query: marker, rating: "useful", sessionId, itemIds: [itemId] }
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    assert.deepEqual(feedback.json().hitRate, { sessionId, hits: 1, itemsSent: 1, rate: 1 });

    const editPayload = { query: marker, rating: "useful", sessionId, taskId, editedPaths: [`.brain/04-engineering/${itemId}.md`] };
    const noLeaseEdit = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers, payload: editPayload });
    assert.equal(noLeaseEdit.statusCode, 403, "edit evidence requires a current actor-owned lease");
    const mcpNoLeaseEdit = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "brain_record_learning", arguments: { projectId, summary: "No lease edit must be rejected.", sessionId, taskId, editedPaths: editPayload.editedPaths } } }
    });
    const mcpNoLeasePayload = JSON.parse(mcpNoLeaseEdit.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    assert.equal(mcpNoLeasePayload.result.isError, true, "MCP edit evidence also rejects missing leases");
    await admin`
      INSERT INTO task_leases (tenant_id, project_id, task_id, actor_id, branch, expires_at)
      VALUES ('default-org', ${projectId}, ${taskId}, 'another-actor', 'test-branch', now() + interval '10 minutes')
      ON CONFLICT (tenant_id, project_id, task_id) DO UPDATE SET actor_id = EXCLUDED.actor_id, expires_at = EXCLUDED.expires_at
    `;
    const otherLeaseEdit = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers, payload: editPayload });
    assert.equal(otherLeaseEdit.statusCode, 403, "another actor's lease cannot authorize edit evidence");
    await admin`
      UPDATE task_leases SET actor_id = 'local-dev', expires_at = now() + interval '10 minutes'
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND task_id = ${taskId}
    `;
    const unchangedSourceEdit = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers, payload: editPayload
    });
    assert.equal(unchangedSourceEdit.statusCode, 200, unchangedSourceEdit.body);
    assert.match(unchangedSourceEdit.json().warnings[0], /não mudou desde a entrega/);
    const mismatchedPathEdit = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers,
      payload: { ...editPayload, editedPaths: ["src/not-the-source.ts"] }
    });
    assert.equal(mismatchedPathEdit.statusCode, 200, mismatchedPathEdit.body);
    assert.equal(mismatchedPathEdit.json().warnings.length, 1, "REST explains that the edited path was not a delivered source");
    const [{ hit_evidence: evidenceBeforeExactPath }] = await admin`
      SELECT hit_evidence FROM context_session_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND session_id = ${sessionId} AND item_id = ${itemId}
    `;
    assert.ok(!evidenceBeforeExactPath.includes("edit"), "unmatched paths do not become edit evidence");
    writeFileSync(workspaceSource, "source changed after Context Pack delivery");
    const exactPathEdit = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/search/feedback`, headers,
      payload: { query: marker, rating: "useful", sessionId, taskId }
    });
    assert.equal(exactPathEdit.statusCode, 200, exactPathEdit.body);
    const mcpExactPathEdit = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "brain_record_learning", arguments: { projectId, summary: "The lease-owned edit was verified.", sessionId, taskId } } }
    });
    const mcpExactPayload = JSON.parse(mcpExactPathEdit.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    assert.equal(mcpExactPayload.result.isError, undefined, "MCP records the exact source path with the active lease");
    const mcpMismatchedPath = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "brain_record_learning", arguments: { projectId, summary: "An unmatched path should warn.", sessionId, taskId, editedPaths: ["src/not-the-source.ts"] } } }
    });
    const mcpMismatchPayload = JSON.parse(mcpMismatchedPath.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    const mcpMismatchResult = JSON.parse(mcpMismatchPayload.result.content[0].text);
    assert.equal(mcpMismatchResult.warnings.length, 1, "MCP also explains unmatched edit paths");
    const [{ hit_evidence: evidenceAfterExactPath }] = await admin`
      SELECT hit_evidence FROM context_session_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND session_id = ${sessionId} AND item_id = ${itemId}
    `;
    assert.ok(evidenceAfterExactPath.includes("edit"), "the exact delivered source URI is recorded with the active lease");

    const mcpContext = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "brain_context_build", arguments: { projectId, task: "helium orchard telescope", intent: "onboarding", includeDomains: [4], tokenBudget: 1200, sessionId, taskId } }
      }
    });
    assert.equal(mcpContext.statusCode, 200, mcpContext.body);
    const mcpContextEvent = mcpContext.body.split(/\r?\n/).find((line) => line.startsWith("data: "));
    assert.ok(mcpContextEvent, "MCP context returns a Streamable HTTP result event");
    const mcpContextPayload = JSON.parse(mcpContextEvent.slice("data: ".length));
    const mcpContextResult = JSON.parse(mcpContextPayload.result.content[0].text);
    assert.ok(mcpContextResult.sources.some((source) => source.id === itemId), "brain_context_build uses query vectors when FTS has no match");
    assert.deepEqual(mcpContextResult.hitRate, { sessionId, hits: 1, itemsSent: 1, rate: 1 }, "repeated MCP delivery does not inflate the denominator");

    const mcpGeneratedSession = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "brain_context_build", arguments: { projectId, task: "empty domain session generation", includeDomains: [11], tokenBudget: 300 } } }
    });
    const mcpGeneratedPayload = JSON.parse(mcpGeneratedSession.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    const mcpGeneratedResult = JSON.parse(mcpGeneratedPayload.result.content[0].text);
    assert.match(mcpGeneratedResult.sessionId, /^[0-9a-f-]{36}$/i, "MCP generates an opaque session ID when omitted");
    assert.deepEqual(mcpGeneratedResult.hitRate, { sessionId: mcpGeneratedResult.sessionId, hits: 0, itemsSent: 0, rate: 0 });

    const mcpGet = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "brain_knowledge_get", arguments: { projectId, id: itemId, sessionId } } }
    });
    assert.equal(mcpGet.statusCode, 200, mcpGet.body);
    const mcpGetPayload = JSON.parse(mcpGet.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    const mcpGetResult = JSON.parse(mcpGetPayload.result.content[0].text);
    assert.deepEqual(mcpGetResult.hitRate, { sessionId, hits: 1, itemsSent: 1, rate: 1 });

    const learning = await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "brain_record_learning", arguments: { projectId, summary: "Used the cited source.", sessionId, taskId, usedItemIds: [itemId, itemId] } } }
    });
    assert.equal(learning.statusCode, 200, learning.body);
    const learningPayload = JSON.parse(learning.body.split(/\r?\n/).find((line) => line.startsWith("data: ")).slice("data: ".length));
    const learningResult = JSON.parse(learningPayload.result.content[0].text);
    assert.equal(learningResult.hitRateUpdated, 0, "repeated learning evidence is idempotent after the REST hit");
    assert.deepEqual(learningResult.hitRate, { sessionId, hits: 1, itemsSent: 1, rate: 1 });
    assert.deepEqual(learningResult.warnings, [], "the original hash still discovers the edit after repeated pack delivery");

    const [{ context_sent_count: sentCount, context_hit_count: hitCount, hit_count: legacyHitCount }] = await admin`
      SELECT context_sent_count, context_hit_count, hit_count FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${itemId}
    `;
    assert.equal(sentCount, 1);
    assert.equal(hitCount, 1);
    assert.equal(legacyHitCount, 0, "session feedback does not rewrite the legacy aggregate");

    const versions = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/knowledge/${itemId}/versions`,
      headers
    });
    assert.equal(versions.statusCode, 200, versions.body);
    assert.equal(versions.json().versions.length, 1, "the initial snapshot is durable");

    const auditRows = await admin`
      SELECT target_id FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND target_id = ${itemId}
    `;
    assert.equal(auditRows.length, 1, "the ingested item has a durable audit row");
  } finally {
    await app.close();
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = 'default-org' AND (from_project_id = ${projectId} OR to_project_id = ${projectId})`;
    await admin`DELETE FROM context_session_items WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM task_leases WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM sync_changes WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM audit_logs WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin.end();
    if (previousEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousEnv.databaseUrl;
    if (previousEnv.databaseSystemUrl === undefined) delete process.env.DATABASE_SYSTEM_URL;
    else process.env.DATABASE_SYSTEM_URL = previousEnv.databaseSystemUrl;
    if (previousEnv.pgStores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = previousEnv.pgStores;
    if (previousEnv.pgBoss === undefined) delete process.env.NOEMA_PG_BOSS;
    else process.env.NOEMA_PG_BOSS = previousEnv.pgBoss;
    if (previousEnv.projectWorkspaceRoots === undefined) delete process.env.NOEMA_PROJECT_WORKSPACE_ROOTS;
    else process.env.NOEMA_PROJECT_WORKSPACE_ROOTS = previousEnv.projectWorkspaceRoots;
    if (previousEnv.workspaceRoot === undefined) delete process.env.NOEMA_WORKSPACE_ROOT;
    else process.env.NOEMA_WORKSPACE_ROOT = previousEnv.workspaceRoot;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
