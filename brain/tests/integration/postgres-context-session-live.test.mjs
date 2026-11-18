import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createAppPostgresClient, createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgKnowledgeRepository } from "../../packages/database/dist/src/repositories.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";
import { parseKnowledgeFile } from "../../packages/knowledge/dist/src/index.js";

const rootUrl = process.env.BRAIN_INTEGRATION_DB_URL;

test("live Context Pack feedback is durable, idempotent, actor-isolated, and policy-scoped", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.BRAIN_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantId = `context-session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const secondSessionId = `session-${randomUUID()}`;
  const ids = [`SESSION-${randomUUID()}`, `SESSION-${randomUUID()}`, `SESSION-${randomUUID()}`];
  const app = createAppPostgresClient({ databaseUrl: appUrl });
  const database = createDatabaseClient(appUrl);
  const knowledge = new PgKnowledgeRepository(database.db);
  const operational = new PgOperationalRepository(database.db);
  const ctx = {
    tenantId, actorId: "session-test-actor", actorType: "human", roles: ["developer"],
    allowedProjects: [projectId], allowedPolicies: ["internal-project", "restricted-security"]
  };
  const item = (id, policy = "internal-project") => parseKnowledgeFile({
    tenantId, projectId, filePath: `.brain/01-business/${id}.md`,
    rawContent: `---\nid: ${id}\ntitle: ${id}\nstatus: approved\naccess_policy: ${policy}\n---\n\nSynthetic session fixture.`
  });

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic context session integration')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, ${tenantId}, 'Synthetic context session project')`;
    for (const id of ids.slice(0, 2)) await knowledge.upsertItem(ctx, item(id));
    await knowledge.upsertItem(ctx, item(ids[2], "restricted-security"));

    const sources = ids.slice(0, 2).map((id, index) => ({ itemId: id, accessPolicyId: "internal-project", sourceUri: `.brain/01-business/${id}.md`, ...(index === 0 ? { taskId: "lease-task", sourceHash: "a".repeat(64) } : {}) }));
    const first = await operational.recordContextDelivery(ctx, projectId, sessionId, sources);
    assert.deepEqual(first, { sessionId, hits: 0, itemsSent: 2, rate: 0 });
    const repeated = await operational.recordContextDelivery(ctx, projectId, sessionId, sources);
    assert.deepEqual(repeated, first, "repeated packs do not inflate the distinct item denominator");
    await operational.recordContextDelivery(ctx, projectId, sessionId, sources.map((source, index) => index === 0 ? { ...source, sourceHash: "b".repeat(64) } : source));
    const editCandidates = await operational.getContextEditCandidates(ctx, projectId, sessionId, "lease-task");
    assert.deepEqual(editCandidates, [{ sourceUri: sources[0].sourceUri, sourceHash: "a".repeat(64) }], "the first delivery baseline survives repeated packs");

    const read = await operational.recordContextEvidence(ctx, projectId, sessionId, [ids[0]], "read");
    assert.equal(read.rate.hits, 1);
    assert.equal(read.rate.itemsSent, 2);
    assert.equal(read.rate.rate, 0.5);
    const repeatedRead = await operational.recordContextEvidence(ctx, projectId, sessionId, [ids[0]], "read");
    assert.deepEqual(repeatedRead.rate, read.rate, "repeated evidence is idempotent");
    const secondHit = await operational.recordContextEvidence(ctx, projectId, sessionId, [ids[1]], "citation");
    assert.deepEqual(secondHit.rate, { sessionId, hits: 2, itemsSent: 2, rate: 1 });
    const firstEdges = await admin`
      SELECT from_item_id, to_item_id, confidence, is_inferred FROM knowledge_relations
      WHERE tenant_id = ${tenantId} AND relation_type = 'CO_ACCESSED_WITH'
        AND ((from_item_id = ${ids[0]} AND to_item_id = ${ids[1]}) OR (from_item_id = ${ids[1]} AND to_item_id = ${ids[0]}))
    `;
    assert.equal(firstEdges.length, 2, "co-access edges are stored in both directions");
    assert.ok(firstEdges.every((edge) => edge.is_inferred && Number(edge.confidence) === 0.5));

    await operational.recordContextDelivery(ctx, projectId, secondSessionId, sources);
    await operational.recordContextEvidence(ctx, projectId, secondSessionId, [ids[0]], "read");
    await operational.recordContextEvidence(ctx, projectId, secondSessionId, [ids[1]], "citation");
    const reinforcedEdges = await admin`
      SELECT confidence FROM knowledge_relations
      WHERE tenant_id = ${tenantId} AND relation_type = 'CO_ACCESSED_WITH'
        AND ((from_item_id = ${ids[0]} AND to_item_id = ${ids[1]}) OR (from_item_id = ${ids[1]} AND to_item_id = ${ids[0]}))
    `;
    assert.ok(reinforcedEdges.every((edge) => Math.abs(Number(edge.confidence) - 0.6) < 0.0001), "a later session reinforces inferred edges");

    const otherActor = { ...ctx, actorId: "different-session-actor" };
    assert.deepEqual(await operational.getContextHitRate(otherActor, projectId, sessionId), {
      sessionId, hits: 0, itemsSent: 0, rate: 0
    });

    await assert.rejects(
      operational.recordContextDelivery(
        { ...ctx, allowedPolicies: ["internal-project"] },
        projectId,
        `restricted-${randomUUID()}`,
        [sources[0], { itemId: ids[2], accessPolicyId: "restricted-security", sourceUri: `.brain/01-business/${ids[2]}.md` }]
      ),
      /missing|authorized|scope|policy/i,
      "a hidden policy item rejects the whole delivery batch"
    );
    const [{ count: rejectedBatchRows }] = await admin`
      SELECT count(*)::int AS count FROM context_session_items
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND session_id LIKE 'restricted-%'
    `;
    assert.equal(rejectedBatchRows, 0, "a rejected policy batch persists no session items");

    const [{ context_sent_count: sentCount, context_hit_count: hitCount, hit_count: legacyHitCount }] = await admin`
      SELECT context_sent_count, context_hit_count, hit_count FROM knowledge_items
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${ids[0]}
    `;
    assert.equal(sentCount, 2);
    assert.equal(hitCount, 2);
    assert.equal(legacyHitCount, 0, "session evidence does not rewrite legacy hit_count");

    await assert.rejects(operational.recordContextEdits(ctx, projectId, sessionId, "lease-task", [sources[0].sourceUri]), /lease/i,
      "edit evidence cannot be written after a lease expires or is absent");
    await operational.upsertLease({ ...ctx, actorId: "other-edit-actor" }, projectId, "lease-task", "test-branch");
    await assert.rejects(operational.recordContextEdits(ctx, projectId, sessionId, "lease-task", [sources[0].sourceUri]), /lease/i,
      "edit evidence cannot use another actor's lease");
    await operational.upsertLease(ctx, projectId, "lease-task", "test-branch");
    const edited = await operational.recordContextEdits(ctx, projectId, sessionId, "lease-task", [sources[0].sourceUri]);
    assert.equal(edited.rate.rate, 1);
    const [{ hit_evidence: editEvidence }] = await admin`
      SELECT hit_evidence FROM context_session_items
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND actor_id = ${ctx.actorId}
        AND session_id = ${sessionId} AND item_id = ${ids[0]}
    `;
    assert.ok(editEvidence.includes("edit"), "same-actor active lease records exact delivered source path evidence");
    const mismatchedEdit = await operational.recordContextEdits(ctx, projectId, sessionId, "lease-task", ["unrelated/file.ts"]);
    assert.deepEqual(mismatchedEdit.newlyHit, [], "unmatched edit paths do not create hits");
  } finally {
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = ${tenantId}`;
    try { await admin`DELETE FROM context_session_items WHERE tenant_id = ${tenantId}`; } catch {}
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${tenantId}`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = ${tenantId}`;
    await admin`DELETE FROM projects WHERE tenant_id = ${tenantId}`;
    await admin`DELETE FROM organizations WHERE id = ${tenantId}`;
    await app.close();
    await database.client.end();
    await admin.end();
  }
});
