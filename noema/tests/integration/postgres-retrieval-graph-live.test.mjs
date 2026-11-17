import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createAppPostgresClient, createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgKnowledgeRepository } from "../../packages/database/dist/src/repositories.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";
import { PostgresGraphStore } from "../../packages/graph/dist/src/index.js";
import { PostgresRetrievalEngine } from "../../packages/retrieval/dist/src/sql-retrieval.js";
import { parseKnowledgeFile } from "../../packages/knowledge/dist/src/index.js";

const rootUrl = process.env.NOEMA_INTEGRATION_DB_URL;

test("live PostgreSQL knowledge versions, exact scope, and graph traversal", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.NOEMA_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantId = `live-retrieval-${randomUUID()}`;
  const otherTenantId = `live-retrieval-other-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const externalProjectId = `external-${randomUUID()}`;
  const itemIds = [
    `LIVE-${randomUUID()}`,
    `LIVE-RESTRICTED-${randomUUID()}`,
    `LIVE-ORG-${randomUUID()}`
  ];
  const crossTenantItemId = `LIVE-OTHER-${randomUUID()}`;
  const app = createAppPostgresClient({ databaseUrl: appUrl });
  const database = createDatabaseClient(appUrl);
  const baseCtx = {
    tenantId, actorId: "postgres-live-test", actorType: "human", roles: ["developer"],
    allowedProjects: [projectId, externalProjectId],
    allowedPolicies: ["internal-project", "restricted-security"]
  };

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic retrieval integration')`;
    await admin`INSERT INTO organizations (id, name) VALUES (${otherTenantId}, 'Synthetic other tenant integration')`;
    const repository = new PgKnowledgeRepository(database.db);
    const item = (id, project, policy, body, version, itemTenantId = tenantId) => parseKnowledgeFile({
      tenantId: itemTenantId,
      projectId: project,
      filePath: `.brain/01-business/${id}.md`,
      rawContent: `---\nid: ${id}\ntitle: ${body}\nstatus: approved\naccess_policy: ${policy}\nsource_version: ${version}\n---\n\n${body}`
    });
    const firstVersion = item(itemIds[0], projectId, "internal-project", "noema live alpha fixture", "v1");
    assert.deepEqual(await repository.upsertItem(baseCtx, firstVersion), { version: 1, changed: true });
    assert.deepEqual(await repository.upsertItem(baseCtx, firstVersion), { version: 1, changed: false }, "same content does not create a duplicate version");
    const secondVersion = item(itemIds[0], projectId, "internal-project", "noema live beta fixture", "v2");
    assert.deepEqual(await repository.upsertItem(baseCtx, secondVersion), { version: 2, changed: true });

    const history = await app.withRlsTransaction(baseCtx, (tx) => tx`
      SELECT version, content_hash FROM knowledge_item_versions
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND item_id = ${itemIds[0]}
      ORDER BY version
    `);
    assert.deepEqual(history.map((row) => Number(row.version)), [1, 2], "changed content appends a version snapshot");

    const restrictedItem = item(itemIds[1], projectId, "restricted-security", "noema live beta restricted fixture", "v1");
    await repository.upsertItem(baseCtx, restrictedItem);
    const otherTenantCtx = { ...baseCtx, tenantId: otherTenantId };
    const otherTenantItem = item(crossTenantItemId, projectId, "internal-project", "noema live beta fixture other tenant", "v1", otherTenantId);
    await repository.upsertItem(otherTenantCtx, otherTenantItem);
    const testVector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
    await repository.upsertEmbedding(baseCtx, {
      projectId, knowledgeItemId: itemIds[0], sourceVersion: "2", chunkIndex: 0,
      chunkText: secondVersion.content, accessPolicyId: "internal-project",
      embeddingModel: "noema-live-test", embedding: testVector
    });
    await repository.upsertEmbedding(baseCtx, {
      projectId, knowledgeItemId: itemIds[0], sourceVersion: "2", chunkIndex: 0,
      chunkText: secondVersion.content, accessPolicyId: "internal-project",
      embeddingModel: "noema-live-test", embedding: testVector
    });
    const [{ count: duplicateEmbeddingCount }] = await app.withRlsTransaction(baseCtx, (tx) => tx`
      SELECT count(*)::int AS count FROM knowledge_embeddings
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND knowledge_item_id = ${itemIds[0]}
        AND source_version = '2' AND chunk_index = 0 AND embedding_model = 'noema-live-test'
    `);
    assert.equal(duplicateEmbeddingCount, 1, "replaying an embedding job must update the existing chunk, not duplicate it");
    await repository.upsertEmbedding(baseCtx, {
      projectId, knowledgeItemId: itemIds[1], sourceVersion: "1", chunkIndex: 0,
      chunkText: restrictedItem.content, accessPolicyId: "restricted-security",
      embeddingModel: "noema-live-test", embedding: testVector
    });
    const orgCtx = { ...baseCtx, allowedProjects: ["__org__"] };
    const orgItem = item(itemIds[2], "__org__", "internal-project", "noema live organization fixture", "v1");
    await repository.upsertItem(orgCtx, orgItem);

    const graph = new PostgresGraphStore(app);
    const rootItemId = `GRAPH-${randomUUID()}`;
    const inProjectItemId = `GRAPH-${randomUUID()}`;
    const outsideProjectItemId = `GRAPH-${randomUUID()}`;
    for (const id of [rootItemId, inProjectItemId, outsideProjectItemId]) itemIds.push(id);
    await graph.addEdge({
      tenantId, fromProjectId: projectId, toProjectId: projectId,
      fromItemId: rootItemId, toItemId: inProjectItemId,
      fromPolicyId: "internal-project", toPolicyId: "internal-project",
      relationType: "DEPENDS_ON", isInferred: false, confidence: 1
    }, baseCtx);
    await graph.addEdge({
      tenantId, fromProjectId: projectId, toProjectId: externalProjectId,
      fromItemId: rootItemId, toItemId: outsideProjectItemId,
      fromPolicyId: "internal-project", toPolicyId: "internal-project",
      relationType: "DEPENDS_ON", isInferred: false, confidence: 1
    }, baseCtx);
    const narrowCtx = { ...baseCtx, allowedProjects: [projectId], allowedPolicies: ["internal-project"] };
    const narrowHits = await graph.traverseRelated(narrowCtx, { projectId, itemId: rootItemId }, 1);
    assert.ok(narrowHits.some((hit) => hit.itemId === inProjectItemId));
    assert.ok(!narrowHits.some((hit) => hit.itemId === outsideProjectItemId), "graph traversal cannot cross into an unauthorized project");
    const wideHits = await graph.traverseRelated(baseCtx, { projectId, itemId: rootItemId }, 1);
    assert.ok(wideHits.some((hit) => hit.itemId === outsideProjectItemId), "authorized cross-project traversal remains available");

    const retrieval = new PostgresRetrievalEngine(app, graph);
    const internalHits = await retrieval.search(narrowCtx, { projectId, query: "noema live beta fixture", limit: 10 });
    assert.ok(internalHits.some((hit) => hit.item.id === itemIds[0]), "SQL FTS returns the authorized persisted item");
    assert.ok(!internalHits.some((hit) => hit.item.id === itemIds[1]), "SQL FTS excludes an item under an unauthorized policy");
    assert.ok(!internalHits.some((hit) => hit.item.id === crossTenantItemId), "SQL FTS excludes matching knowledge from another tenant");
    const restrictedCtx = { ...narrowCtx, allowedPolicies: ["restricted-security"] };
    const restrictedHits = await retrieval.search(restrictedCtx, { projectId, query: "noema live beta fixture", limit: 10 });
    assert.ok(restrictedHits.some((hit) => hit.item.id === itemIds[1]), "the authorized restricted policy remains searchable");
    assert.ok(!restrictedHits.some((hit) => hit.item.id === itemIds[0]), "a policy-specific cache entry cannot expose internal-only rows");
    const otherTenantHits = await retrieval.search(otherTenantCtx, { projectId, query: "noema live beta fixture", limit: 10 });
    assert.ok(otherTenantHits.some((hit) => hit.item.id === crossTenantItemId), "the same query is executed within the second tenant's scope");
    assert.ok(!otherTenantHits.some((hit) => hit.item.id === itemIds[0]), "a cached result from tenant A cannot leak into tenant B");
    const internalHitsAfterTenantSwitch = await retrieval.search(narrowCtx, { projectId, query: "noema live beta fixture", limit: 10 });
    assert.ok(!internalHitsAfterTenantSwitch.some((hit) => hit.item.id === crossTenantItemId), "switching tenants does not contaminate tenant A's cache entry");
    const beforeFeedback = await retrieval.search(narrowCtx, {
      projectId, query: "noema live beta fixture", limit: 10, explain: true
    });
    const beforeFeedbackHit = beforeFeedback.find((hit) => hit.item.id === itemIds[0]);
    assert.equal(beforeFeedbackHit?.explain?.hitRateBoost, 0, "items start without a hit-rate boost");
    const hitCount = await repository.incrementHitCount(narrowCtx, projectId, itemIds[0]);
    assert.equal(hitCount, 1, "legacy feedback remains independently durable under RLS");
    await assert.rejects(
      repository.incrementHitCounts(narrowCtx, projectId, [itemIds[0], itemIds[1]]),
      /outside the authorized scope/
    );
    const [{ hit_count: unchangedHitCount }] = await admin`
      SELECT hit_count FROM knowledge_items
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${itemIds[0]}
    `;
    assert.equal(unchangedHitCount, 1, "a mixed-policy legacy feedback batch rolls back instead of partially updating");
    retrieval.invalidateCache(tenantId, projectId);
    const afterFeedback = await retrieval.search(narrowCtx, {
      projectId, query: "noema live beta fixture", limit: 10, explain: true
    });
    const afterFeedbackHit = afterFeedback.find((hit) => hit.item.id === itemIds[0]);
    assert.equal(afterFeedbackHit?.explain?.hitRateBoost, 0, "legacy hit_count does not affect session ranking");

    const operational = new PgOperationalRepository(database.db);
    const sessionId = `retrieval-session-${randomUUID()}`;
    const delivered = await operational.recordContextDelivery(narrowCtx, projectId, sessionId, [{
      itemId: itemIds[0], accessPolicyId: "internal-project", sourceUri: firstVersion.sourceUri
    }]);
    assert.deepEqual(delivered, { sessionId, hits: 0, itemsSent: 1, rate: 0 });
    const learned = await operational.recordContextEvidence(narrowCtx, projectId, sessionId, [itemIds[0]], "citation");
    assert.deepEqual(learned.rate, { sessionId, hits: 1, itemsSent: 1, rate: 1 });
    retrieval.invalidateCache(tenantId, projectId);
    const afterSessionEvidence = await retrieval.search(narrowCtx, {
      projectId, query: "noema live beta fixture", limit: 10, explain: true
    });
    const sessionRankedHit = afterSessionEvidence.find((hit) => hit.item.id === itemIds[0]);
    assert.equal(sessionRankedHit?.explain?.hitRateBoost, 1, "cache invalidation exposes persisted session hit rate immediately");
    const restartedRetrieval = new PostgresRetrievalEngine(app, graph);
    const feedbackRanked = await restartedRetrieval.search(narrowCtx, {
      projectId, query: "noema live beta fixture", limit: 10, explain: true
    });
    const feedbackHit = feedbackRanked.find((hit) => hit.item.id === itemIds[0]);
    assert.equal(feedbackHit?.explain?.hitRateBoost, 1, "a fresh retrieval engine uses persisted session hit rate");
    const vectorHits = await retrieval.search(narrowCtx, {
      projectId, query: "semantic fixture", queryEmbedding: testVector,
      embeddingModel: "noema-live-test", limit: 10
    });
    assert.ok(vectorHits.some((hit) => hit.item.id === itemIds[0]), "exact pgvector similarity returns the authorized embedding");
    assert.ok(!vectorHits.some((hit) => hit.item.id === itemIds[1]), "exact pgvector search filters restricted embeddings before ranking");
    const otherTenantVectorHits = await retrieval.search(otherTenantCtx, {
      projectId, query: "semantic fixture", queryEmbedding: testVector, embeddingModel: "noema-live-test", limit: 10
    });
    assert.ok(!otherTenantVectorHits.some((hit) => hit.item.id === itemIds[0]), "vector cache and pgvector results cannot expose another tenant's embedding");
    const withoutOrg = await retrieval.search(narrowCtx, { projectId, query: "noema live organization fixture", limit: 10 });
    assert.ok(!withoutOrg.some((hit) => hit.item.id === itemIds[2]), "organization knowledge is hidden unless __org__ is authorized");
    const withOrgCtx = { ...narrowCtx, allowedProjects: [projectId, "__org__"] };
    const withOrg = await retrieval.search(withOrgCtx, { projectId, query: "noema live organization fixture", limit: 10 });
    assert.ok(withOrg.some((hit) => hit.item.id === itemIds[2]), "authorized organization knowledge participates in SQL retrieval");
  } finally {
    try {
      for (const id of itemIds) {
        await admin`DELETE FROM knowledge_relations WHERE tenant_id = ${tenantId} AND (from_item_id = ${id} OR to_item_id = ${id})`;
        await admin`DELETE FROM context_session_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND item_id = ${id}`;
        await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = ${tenantId} AND knowledge_item_id = ${id}`;
        await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${tenantId} AND item_id = ${id}`;
        await admin`DELETE FROM sync_changes WHERE tenant_id = ${tenantId} AND item_id = ${id}`;
        await admin`DELETE FROM knowledge_items WHERE tenant_id = ${tenantId} AND id = ${id}`;
      }
      await admin`DELETE FROM knowledge_relations WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM sync_project_locks WHERE tenant_id = ${tenantId}`;
      await admin`DELETE FROM organizations WHERE id = ${tenantId}`;
      await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${otherTenantId} AND item_id = ${crossTenantItemId}`;
      await admin`DELETE FROM sync_changes WHERE tenant_id = ${otherTenantId} AND item_id = ${crossTenantItemId}`;
      await admin`DELETE FROM knowledge_items WHERE tenant_id = ${otherTenantId} AND id = ${crossTenantItemId}`;
      await admin`DELETE FROM sync_project_locks WHERE tenant_id = ${otherTenantId}`;
      await admin`DELETE FROM organizations WHERE id = ${otherTenantId}`;
    } finally {
      await app.close();
      await database.client.end();
      await admin.end();
    }
  }
});
