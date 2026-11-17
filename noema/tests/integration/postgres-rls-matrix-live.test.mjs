import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createAppPostgresClient, createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgKnowledgeRepository } from "../../packages/database/dist/src/repositories.js";
import { PostgresGraphStore } from "../../packages/graph/dist/src/index.js";
import { createPostgresAuditLogger } from "../../packages/audit-engine/dist/src/index.js";
import { parseKnowledgeFile } from "../../packages/knowledge/dist/src/index.js";

const rootUrl = process.env.NOEMA_INTEGRATION_DB_URL;

test("live RLS matrix isolates tenant, project, policy, and actor rows across 26 protected tables", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.NOEMA_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantA = `rls-matrix-a-${randomUUID()}`;
  const tenantB = `rls-matrix-b-${randomUUID()}`;
  const projectA1 = `project-a1-${randomUUID()}`;
  const projectA2 = `project-a2-${randomUUID()}`;
  const projectB1 = `project-b1-${randomUUID()}`;
  const itemIds = Array.from({ length: 5 }, () => `RLS-${randomUUID()}`);
  const fixturePrefix = `rls-operational-${randomUUID()}`;
  const auditTargetType = `rls_matrix_fixture_${randomUUID()}`;
  const auditTargets = {
    a1: `audit-a1-${randomUUID()}`,
    a2: `audit-a2-${randomUUID()}`,
    aRestricted: `audit-a-restricted-${randomUUID()}`,
    b1: `audit-b1-${randomUUID()}`
  };
  const app = createAppPostgresClient({ databaseUrl: appUrl });
  const database = createDatabaseClient(appUrl);
  const ctxA = {
    tenantId: tenantA, actorId: "rls-matrix-test", actorType: "system", roles: ["system"],
    allowedProjects: [projectA1, projectA2], allowedPolicies: ["internal-project", "restricted-security"]
  };
  const ctxB = {
    tenantId: tenantB, actorId: "rls-matrix-test", actorType: "system", roles: ["system"],
    allowedProjects: [projectB1], allowedPolicies: ["internal-project"]
  };

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantA}, 'RLS matrix tenant A'), (${tenantB}, 'RLS matrix tenant B')`;
    await admin`
      INSERT INTO projects (id, tenant_id, name) VALUES
        (${projectA1}, ${tenantA}, 'RLS project A1'),
        (${projectA2}, ${tenantA}, 'RLS project A2'),
        (${projectB1}, ${tenantB}, 'RLS project B1')
    `;

    const repository = new PgKnowledgeRepository(database.db);
    const addItem = async (ctx, id, projectId, accessPolicyId) => {
      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId,
        filePath: `.brain/01-business/${id}.md`,
        rawContent: `---\nid: ${id}\ntitle: RLS matrix ${id}\nstatus: approved\naccess_policy: ${accessPolicyId}\n---\n\nSynthetic row for PostgreSQL RLS matrix ${id}`
      });
      await repository.upsertItem(ctx, item);
      return item;
    };

    const items = [
      await addItem(ctxA, itemIds[0], projectA1, "internal-project"),
      await addItem(ctxA, itemIds[1], projectA2, "internal-project"),
      await addItem(ctxA, itemIds[2], projectA1, "restricted-security"),
      await addItem(ctxB, itemIds[3], projectB1, "internal-project"),
      await addItem(ctxA, itemIds[4], projectA1, "internal-project")
    ];
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
    for (const [index, item] of items.entries()) {
      const ctx = index === 3 ? ctxB : ctxA;
      await repository.upsertEmbedding(ctx, {
        projectId: item.projectId, knowledgeItemId: item.id, sourceVersion: "v1", chunkIndex: 0,
        chunkText: item.content, accessPolicyId: item.accessPolicyId,
        embeddingModel: "rls-matrix-test", embedding: vector
      });
    }

    const graph = new PostgresGraphStore(app);
    const edges = [
      { ctx: ctxA, tenantId: tenantA, fromProjectId: projectA1, toProjectId: projectA1, fromItemId: itemIds[0], toItemId: itemIds[4], fromPolicyId: "internal-project", toPolicyId: "internal-project" },
      { ctx: ctxA, tenantId: tenantA, fromProjectId: projectA1, toProjectId: projectA2, fromItemId: itemIds[0], toItemId: itemIds[1], fromPolicyId: "internal-project", toPolicyId: "internal-project" },
      { ctx: ctxA, tenantId: tenantA, fromProjectId: projectA1, toProjectId: projectA1, fromItemId: itemIds[0], toItemId: itemIds[2], fromPolicyId: "internal-project", toPolicyId: "restricted-security" },
      { ctx: ctxB, tenantId: tenantB, fromProjectId: projectB1, toProjectId: projectB1, fromItemId: itemIds[3], toItemId: itemIds[3], fromPolicyId: "internal-project", toPolicyId: "internal-project" }
    ];
    for (const { ctx, ...edge } of edges) {
      await graph.addEdge({ ...edge, relationType: "DEPENDS_ON", isInferred: false, confidence: 1 }, ctx);
    }

    const auditA = createPostgresAuditLogger(app, ctxA);
    const auditB = createPostgresAuditLogger(app, ctxB);
    const auditEvents = [
      { logger: auditA, tenantId: tenantA, projectId: projectA1, accessPolicyId: "internal-project", targetId: auditTargets.a1 },
      { logger: auditA, tenantId: tenantA, projectId: projectA2, accessPolicyId: "internal-project", targetId: auditTargets.a2 },
      { logger: auditA, tenantId: tenantA, projectId: projectA1, accessPolicyId: "restricted-security", targetId: auditTargets.aRestricted },
      { logger: auditB, tenantId: tenantB, projectId: projectB1, accessPolicyId: "internal-project", targetId: auditTargets.b1 }
    ];
    for (const { logger, ...event } of auditEvents) {
      await logger.record({
        ...event, actorId: "rls-matrix-test", actorType: "system", action: "create",
        targetType: auditTargetType, metadata: { synthetic: true }
      });
    }

    const operationalScopes = [
      { key: "a1-internal", tenantId: tenantA, projectId: projectA1, policy: "internal-project", itemId: itemIds[0] },
      { key: "a2-internal", tenantId: tenantA, projectId: projectA2, policy: "internal-project", itemId: itemIds[1] },
      { key: "a1-restricted", tenantId: tenantA, projectId: projectA1, policy: "restricted-security", itemId: itemIds[2] },
      { key: "b1-internal", tenantId: tenantB, projectId: projectB1, policy: "internal-project", itemId: itemIds[3] }
    ];
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    for (const scope of operationalScopes) {
      const marker = `${fixturePrefix}-${scope.key}`;
      await admin`INSERT INTO handoffs (handoff_id, tenant_id, project_id, task_id, from_agent, repo_url, branch, base_commit_sha, actor_id)
        VALUES (${`${marker}-handoff`}, ${scope.tenantId}, ${scope.projectId}, ${`${marker}-task`}, 'test-agent', 'https://example.invalid/repo', 'test-branch', 'deadbeef', 'rls-matrix-test')`;
      await admin`INSERT INTO memory_entries (tenant_id, project_id, layer, session_id, content, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, 'episodic', ${`${marker}-session`}, ${`${marker}-memory`}, ${scope.policy})`;
      await admin`INSERT INTO runner_tasks (task_id, tenant_id, project_id, instruction, status, actor_id)
        VALUES (${`${marker}-runner`}, ${scope.tenantId}, ${scope.projectId}, ${`${marker}-instruction`}, 'queued', 'rls-matrix-test')`;
      await admin`INSERT INTO sync_changes (tenant_id, project_id, item_id, content_hash, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`${marker}-sync`}, ${`${marker}-hash`}, ${scope.policy})`;
      await admin`INSERT INTO task_leases (tenant_id, project_id, task_id, actor_id, branch, expires_at)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`${marker}-lease`}, 'rls-matrix-test', 'test-branch', ${dueAt})`;
      await admin`INSERT INTO approval_requests (tenant_id, project_id, item_id, domain_id, requested_by, actor_type, status, access_policy_id, due_at)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`${marker}-approval`}, 1, 'rls-matrix-test', 'system', 'pending', ${scope.policy}, ${dueAt})`;
      await admin`INSERT INTO context_session_items (tenant_id, project_id, actor_id, session_id, item_id, access_policy_id, source_uri, task_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, 'rls-matrix-test', ${`${marker}-context`}, ${scope.itemId}, ${scope.policy}, ${`.brain/${marker}.md`}, ${`${marker}-task`})`;
      await admin`INSERT INTO notification_preferences (tenant_id, project_id, actor_id, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, 'rls-matrix-test', ${scope.policy})`;
      await admin`INSERT INTO approval_reminder_events (tenant_id, project_id, proposal_id, access_policy_id, due_at, event_type)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`${marker}-reminder`}, ${scope.policy}, ${dueAt}, 'reminder')`;
      await admin`INSERT INTO integration_events (tenant_id, provider, external_event_id, project_id, proposal_id, access_policy_id, event_hash, status)
        VALUES (${scope.tenantId}, 'jira', ${`${marker}-event`}, ${scope.projectId}, ${`${marker}-proposal`}, ${scope.policy}, ${`${marker}-hash`}, 'completed')`;
      await admin`INSERT INTO cross_service_contracts (tenant_id, from_project_id, from_service, relation, to_project_id, contract_id, schema_version, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`${marker}-source`}, 'CONSUMES_API', ${scope.projectId}, ${`${marker}-contract`}, 'v1', ${scope.policy})`;
      await admin`INSERT INTO runner_task_questions (question_id, tenant_id, project_id, task_id, access_policy_id, question)
        VALUES (${`${marker}-question`}, ${scope.tenantId}, ${scope.projectId}, ${`${marker}-task`}, ${scope.policy}, ${`${marker}-question-text`})`;
      await admin`INSERT INTO test_execution_results (tenant_id, project_id, access_policy_id, provider, run_id, test_item_id, commit_sha, status, executed_at, received_by)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${scope.policy}, 'rls-matrix', ${`${marker}-run`}, ${`${marker}-test`}, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'passed', ${dueAt}, 'rls-matrix-test')`;
      await admin`INSERT INTO project_repository_heads (tenant_id, project_id, repository, branch, commit_sha, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`acme/${marker}`}, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ${scope.policy})`;
      await admin`INSERT INTO git_ingestion_heads (tenant_id, project_id, repository, branch, commit_sha, access_policy_id)
        VALUES (${scope.tenantId}, ${scope.projectId}, ${`acme/${marker}`}, ${`${marker}-branch`}, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ${scope.policy})`;
      await admin`INSERT INTO notification_outbox (tenant_id, project_id, actor_id, access_policy_id, channel, category, event_key, payload, scheduled_at)
        VALUES (${scope.tenantId}, ${scope.projectId}, 'rls-matrix-test', ${scope.policy}, 'slack', 'approval', ${`${marker}-outbox`}, ${JSON.stringify({ synthetic: true })}::jsonb, ${dueAt})`;
    }
    for (const scope of [operationalScopes[0], operationalScopes[1], operationalScopes[3]]) {
      await admin`INSERT INTO policy_epoch_states (tenant_id, project_id, actor_id, epoch)
        VALUES (${scope.tenantId}, ${scope.projectId}, 'rls-matrix-test', 2)`;
      await admin`INSERT INTO runner_token_usage_daily (tenant_id, project_id, usage_date, used_tokens)
        VALUES (${scope.tenantId}, ${scope.projectId}, current_date, 7)`;
    }
    await admin`INSERT INTO policy_epoch_states (tenant_id, project_id, actor_id, epoch)
      VALUES (${tenantA}, ${projectA1}, 'other-actor', 9)`;
    await admin`INSERT INTO notification_preferences (tenant_id, project_id, actor_id, access_policy_id)
      VALUES (${tenantA}, ${projectA1}, 'other-actor', 'internal-project')`;
    await admin`INSERT INTO notification_outbox (tenant_id, project_id, actor_id, access_policy_id, channel, category, event_key, payload, scheduled_at)
      VALUES (${tenantA}, ${projectA1}, 'other-actor', 'internal-project', 'slack', 'approval', ${`${fixturePrefix}-other-actor-outbox`}, ${JSON.stringify({ synthetic: true })}::jsonb, ${dueAt})`;

    const readRows = (ctx) => app.withRlsTransaction(ctx, async (tx) => {
      await tx`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`;
      const [organizations, projects, knowledgeItems, versions, embeddings, relations, auditLogs, handoffs, memoryEntries, runnerTasks, syncChanges, taskLeases, approvalRequests, contextSessions, notificationPreferences, policyEpochStates, approvalReminders, integrationEvents, crossServiceContracts, runnerQuestions, testResults, repositoryHeads, ingestionHeads, notificationOutbox, tokenUsage, syncLocks] = await Promise.all([
        tx`SELECT id FROM organizations ORDER BY id`,
        tx`SELECT id FROM projects ORDER BY id`,
        tx`SELECT id FROM knowledge_items ORDER BY id`,
        tx`SELECT item_id FROM knowledge_item_versions ORDER BY item_id`,
        tx`SELECT knowledge_item_id FROM knowledge_embeddings ORDER BY knowledge_item_id`,
        tx`SELECT from_item_id, to_item_id FROM knowledge_relations ORDER BY to_item_id`,
        tx`SELECT target_id FROM audit_logs WHERE target_type = ${auditTargetType} ORDER BY target_id`,
        tx`SELECT handoff_id FROM handoffs WHERE handoff_id LIKE ${`${fixturePrefix}-%`} ORDER BY handoff_id`,
        tx`SELECT content FROM memory_entries WHERE content LIKE ${`${fixturePrefix}-%`} ORDER BY content`,
        tx`SELECT task_id FROM runner_tasks WHERE task_id LIKE ${`${fixturePrefix}-%`} ORDER BY task_id`,
        tx`SELECT item_id FROM sync_changes WHERE item_id LIKE ${`${fixturePrefix}-%`} ORDER BY item_id`,
        tx`SELECT task_id FROM task_leases WHERE task_id LIKE ${`${fixturePrefix}-%`} ORDER BY task_id`,
        tx`SELECT item_id FROM approval_requests WHERE item_id LIKE ${`${fixturePrefix}-%`} ORDER BY item_id`,
        tx`SELECT session_id FROM context_session_items WHERE session_id LIKE ${`${fixturePrefix}-%`} ORDER BY session_id`,
        tx`SELECT access_policy_id, actor_id FROM notification_preferences WHERE actor_id IN ('rls-matrix-test', 'other-actor') ORDER BY project_id, access_policy_id, actor_id`,
        tx`SELECT project_id, actor_id FROM policy_epoch_states WHERE project_id IN (${projectA1}, ${projectA2}, ${projectB1}) ORDER BY project_id, actor_id`,
        tx`SELECT proposal_id FROM approval_reminder_events WHERE proposal_id LIKE ${`${fixturePrefix}-%`} ORDER BY proposal_id`,
        tx`SELECT external_event_id FROM integration_events WHERE external_event_id LIKE ${`${fixturePrefix}-%`} ORDER BY external_event_id`,
        tx`SELECT contract_id FROM cross_service_contracts WHERE contract_id LIKE ${`${fixturePrefix}-%`} ORDER BY contract_id`,
        tx`SELECT question_id FROM runner_task_questions WHERE question_id LIKE ${`${fixturePrefix}-%`} ORDER BY question_id`,
        tx`SELECT test_item_id FROM test_execution_results WHERE test_item_id LIKE ${`${fixturePrefix}-%`} ORDER BY test_item_id`,
        tx`SELECT repository FROM project_repository_heads WHERE repository LIKE ${`%${fixturePrefix}-%`} ORDER BY repository`,
        tx`SELECT repository, branch FROM git_ingestion_heads WHERE repository LIKE ${`%${fixturePrefix}-%`} ORDER BY repository, branch`,
        tx`SELECT event_key, actor_id FROM notification_outbox WHERE event_key LIKE ${`${fixturePrefix}-%`} ORDER BY event_key`,
        tx`SELECT project_id FROM runner_token_usage_daily WHERE project_id IN (${projectA1}, ${projectA2}, ${projectB1}) AND used_tokens = 7 ORDER BY project_id`,
        tx`SELECT project_id FROM sync_project_locks WHERE project_id IN (${projectA1}, ${projectA2}, ${projectB1}) ORDER BY project_id`
      ]);
      return Object.fromEntries(Object.entries({ organizations, projects, knowledgeItems, versions, embeddings, relations, auditLogs, handoffs, memoryEntries, runnerTasks, syncChanges, taskLeases, approvalRequests, contextSessions, notificationPreferences, policyEpochStates, approvalReminders, integrationEvents, crossServiceContracts, runnerQuestions, testResults, repositoryHeads, ingestionHeads, notificationOutbox, tokenUsage, syncLocks })
        .map(([key, rows]) => [key, Array.from(rows)]));
    });

    const operationalMarker = (key) => `${fixturePrefix}-${key}`;
    const operationalIds = (keys, suffix) => keys.map((key) => `${operationalMarker(key)}-${suffix}`).sort();
    const narrow = await readRows({ ...ctxA, allowedProjects: [projectA1], allowedPolicies: ["internal-project"] });
    assert.deepEqual(narrow.organizations.map((row) => row.id), [tenantA]);
    assert.deepEqual(narrow.projects.map((row) => row.id), [projectA1]);
    assert.deepEqual(narrow.knowledgeItems.map((row) => row.id), [itemIds[0], itemIds[4]].sort());
    assert.deepEqual(narrow.versions.map((row) => row.item_id), [itemIds[0], itemIds[4]].sort());
    assert.deepEqual(narrow.embeddings.map((row) => row.knowledge_item_id), [itemIds[0], itemIds[4]].sort());
    assert.deepEqual(narrow.relations, [{ from_item_id: itemIds[0], to_item_id: itemIds[4] }]);
    assert.deepEqual(narrow.auditLogs.map((row) => row.target_id), [auditTargets.a1]);
    assert.deepEqual(narrow.handoffs.map((row) => row.handoff_id), operationalIds(["a1-internal", "a1-restricted"], "handoff"));
    assert.deepEqual(narrow.memoryEntries.map((row) => row.content), operationalIds(["a1-internal"], "memory"));
    assert.deepEqual(narrow.runnerTasks.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted"], "runner"));
    assert.deepEqual(narrow.syncChanges.map((row) => row.item_id), operationalIds(["a1-internal"], "sync"));
    assert.deepEqual(narrow.taskLeases.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted"], "lease"));
    assert.deepEqual(narrow.approvalRequests.map((row) => row.item_id), operationalIds(["a1-internal"], "approval"));
    assert.deepEqual(narrow.contextSessions.map((row) => row.session_id), operationalIds(["a1-internal"], "context"));
    assert.deepEqual(narrow.notificationPreferences.map((row) => `${row.access_policy_id}:${row.actor_id}`), ["internal-project:rls-matrix-test"]);
    assert.deepEqual(narrow.policyEpochStates.map((row) => `${row.project_id}:${row.actor_id}`), [`${projectA1}:rls-matrix-test`]);
    assert.deepEqual(narrow.approvalReminders.map((row) => row.proposal_id), operationalIds(["a1-internal"], "reminder"));
    assert.deepEqual(narrow.integrationEvents.map((row) => row.external_event_id), operationalIds(["a1-internal"], "event"));
    assert.deepEqual(narrow.crossServiceContracts.map((row) => row.contract_id), operationalIds(["a1-internal"], "contract"));
    assert.deepEqual(narrow.runnerQuestions.map((row) => row.question_id), operationalIds(["a1-internal"], "question"));
    assert.deepEqual(narrow.testResults.map((row) => row.test_item_id), operationalIds(["a1-internal"], "test"));
    assert.deepEqual(narrow.repositoryHeads.map((row) => row.repository), [`acme/${operationalMarker("a1-internal")}`]);
    assert.deepEqual(narrow.ingestionHeads, [{ repository: `acme/${operationalMarker("a1-internal")}`, branch: `${operationalMarker("a1-internal")}-branch` }]);
    assert.deepEqual(narrow.notificationOutbox.map((row) => `${row.event_key}:${row.actor_id}`), [`${operationalMarker("a1-internal")}-outbox:rls-matrix-test`]);
    assert.deepEqual(narrow.tokenUsage.map((row) => row.project_id), [projectA1]);
    assert.deepEqual(narrow.syncLocks.map((row) => row.project_id), [projectA1]);

    const projectWide = await readRows({ ...ctxA, allowedPolicies: ["internal-project"] });
    assert.deepEqual(projectWide.knowledgeItems.map((row) => row.id), [itemIds[0], itemIds[1], itemIds[4]].sort());
    assert.deepEqual(projectWide.relations, [
      { from_item_id: itemIds[0], to_item_id: itemIds[1] },
      { from_item_id: itemIds[0], to_item_id: itemIds[4] }
    ].sort((a, b) => a.to_item_id.localeCompare(b.to_item_id)));
    assert.deepEqual(projectWide.auditLogs.map((row) => row.target_id).sort(), [auditTargets.a1, auditTargets.a2].sort());
    assert.deepEqual(projectWide.handoffs.map((row) => row.handoff_id), operationalIds(["a1-internal", "a1-restricted", "a2-internal"], "handoff"));
    assert.deepEqual(projectWide.memoryEntries.map((row) => row.content), operationalIds(["a1-internal", "a2-internal"], "memory"));
    assert.deepEqual(projectWide.runnerTasks.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted", "a2-internal"], "runner"));
    assert.deepEqual(projectWide.syncChanges.map((row) => row.item_id), operationalIds(["a1-internal", "a2-internal"], "sync"));
    assert.deepEqual(projectWide.taskLeases.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted", "a2-internal"], "lease"));
    assert.deepEqual(projectWide.approvalRequests.map((row) => row.item_id), operationalIds(["a1-internal", "a2-internal"], "approval"));
    assert.deepEqual(projectWide.contextSessions.map((row) => row.session_id), operationalIds(["a1-internal", "a2-internal"], "context"));
    assert.deepEqual(projectWide.notificationPreferences.map((row) => `${row.access_policy_id}:${row.actor_id}`).sort(), ["internal-project:rls-matrix-test", "internal-project:rls-matrix-test"].sort());
    assert.deepEqual(projectWide.policyEpochStates.map((row) => `${row.project_id}:${row.actor_id}`), [`${projectA1}:rls-matrix-test`, `${projectA2}:rls-matrix-test`].sort());
    assert.deepEqual(projectWide.approvalReminders.map((row) => row.proposal_id), operationalIds(["a1-internal", "a2-internal"], "reminder"));
    assert.deepEqual(projectWide.integrationEvents.map((row) => row.external_event_id), operationalIds(["a1-internal", "a2-internal"], "event"));
    assert.deepEqual(projectWide.crossServiceContracts.map((row) => row.contract_id), operationalIds(["a1-internal", "a2-internal"], "contract"));
    assert.deepEqual(projectWide.runnerQuestions.map((row) => row.question_id), operationalIds(["a1-internal", "a2-internal"], "question"));
    assert.deepEqual(projectWide.testResults.map((row) => row.test_item_id), operationalIds(["a1-internal", "a2-internal"], "test"));
    assert.deepEqual(projectWide.repositoryHeads.map((row) => row.repository).sort(), ["a1-internal", "a2-internal"].map((key) => `acme/${operationalMarker(key)}`).sort());
    assert.equal(projectWide.ingestionHeads.length, 2);
    assert.deepEqual(projectWide.notificationOutbox.map((row) => row.event_key).sort(), operationalIds(["a1-internal", "a2-internal"], "outbox").sort());
    assert.deepEqual(projectWide.tokenUsage.map((row) => row.project_id), [projectA1, projectA2].sort());
    assert.deepEqual(projectWide.syncLocks.map((row) => row.project_id), [projectA1, projectA2].sort());

    const policyWide = await readRows({ ...ctxA, allowedProjects: [projectA1] });
    assert.deepEqual(policyWide.knowledgeItems.map((row) => row.id), [itemIds[0], itemIds[2], itemIds[4]].sort());
    assert.deepEqual(policyWide.relations, [
      { from_item_id: itemIds[0], to_item_id: itemIds[2] },
      { from_item_id: itemIds[0], to_item_id: itemIds[4] }
    ].sort((a, b) => a.to_item_id.localeCompare(b.to_item_id)));
    assert.deepEqual(policyWide.auditLogs.map((row) => row.target_id).sort(), [auditTargets.aRestricted, auditTargets.a1].sort());
    assert.deepEqual(policyWide.handoffs.map((row) => row.handoff_id), operationalIds(["a1-internal", "a1-restricted"], "handoff"));
    assert.deepEqual(policyWide.memoryEntries.map((row) => row.content), operationalIds(["a1-internal", "a1-restricted"], "memory"));
    assert.deepEqual(policyWide.runnerTasks.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted"], "runner"));
    assert.deepEqual(policyWide.syncChanges.map((row) => row.item_id), operationalIds(["a1-internal", "a1-restricted"], "sync"));
    assert.deepEqual(policyWide.taskLeases.map((row) => row.task_id), operationalIds(["a1-internal", "a1-restricted"], "lease"));
    assert.deepEqual(policyWide.approvalRequests.map((row) => row.item_id).sort(), operationalIds(["a1-internal", "a1-restricted"], "approval").sort());
    assert.deepEqual(policyWide.contextSessions.map((row) => row.session_id).sort(), operationalIds(["a1-internal", "a1-restricted"], "context").sort());
    assert.deepEqual(policyWide.notificationPreferences.map((row) => row.access_policy_id).sort(), ["internal-project", "restricted-security"].sort());
    assert.deepEqual(policyWide.approvalReminders.map((row) => row.proposal_id), operationalIds(["a1-internal", "a1-restricted"], "reminder"));
    assert.deepEqual(policyWide.integrationEvents.map((row) => row.external_event_id), operationalIds(["a1-internal", "a1-restricted"], "event"));
    assert.deepEqual(policyWide.crossServiceContracts.map((row) => row.contract_id), operationalIds(["a1-internal", "a1-restricted"], "contract"));
    assert.deepEqual(policyWide.runnerQuestions.map((row) => row.question_id).sort(), operationalIds(["a1-internal", "a1-restricted"], "question").sort());
    assert.deepEqual(policyWide.testResults.map((row) => row.test_item_id).sort(), operationalIds(["a1-internal", "a1-restricted"], "test").sort());
    assert.deepEqual(policyWide.repositoryHeads.map((row) => row.repository).sort(), ["a1-internal", "a1-restricted"].map((key) => `acme/${operationalMarker(key)}`).sort());
    assert.deepEqual(policyWide.ingestionHeads.map((row) => row.branch).sort(), ["a1-internal", "a1-restricted"].map((key) => `${operationalMarker(key)}-branch`).sort());
    assert.deepEqual(policyWide.notificationOutbox.map((row) => row.event_key).sort(), operationalIds(["a1-internal", "a1-restricted"], "outbox").sort());

    const tenantBRows = await readRows(ctxB);
    assert.deepEqual(tenantBRows.organizations.map((row) => row.id), [tenantB]);
    assert.deepEqual(tenantBRows.projects.map((row) => row.id), [projectB1]);
    assert.deepEqual(tenantBRows.knowledgeItems.map((row) => row.id), [itemIds[3]]);
    assert.deepEqual(tenantBRows.versions.map((row) => row.item_id), [itemIds[3]]);
    assert.deepEqual(tenantBRows.embeddings.map((row) => row.knowledge_item_id), [itemIds[3]]);
    assert.deepEqual(tenantBRows.relations, [{ from_item_id: itemIds[3], to_item_id: itemIds[3] }]);
    assert.deepEqual(tenantBRows.auditLogs.map((row) => row.target_id).sort(), [auditTargets.b1]);
    assert.deepEqual(tenantBRows.handoffs.map((row) => row.handoff_id), operationalIds(["b1-internal"], "handoff"));
    assert.deepEqual(tenantBRows.memoryEntries.map((row) => row.content), operationalIds(["b1-internal"], "memory"));
    assert.deepEqual(tenantBRows.runnerTasks.map((row) => row.task_id), operationalIds(["b1-internal"], "runner"));
    assert.deepEqual(tenantBRows.syncChanges.map((row) => row.item_id), operationalIds(["b1-internal"], "sync"));
    assert.deepEqual(tenantBRows.taskLeases.map((row) => row.task_id), operationalIds(["b1-internal"], "lease"));
    assert.deepEqual(tenantBRows.approvalRequests.map((row) => row.item_id), operationalIds(["b1-internal"], "approval"));
    assert.deepEqual(tenantBRows.contextSessions.map((row) => row.session_id), operationalIds(["b1-internal"], "context"));
    assert.deepEqual(tenantBRows.notificationPreferences.map((row) => `${row.access_policy_id}:${row.actor_id}`), ["internal-project:rls-matrix-test"]);
    assert.deepEqual(tenantBRows.policyEpochStates.map((row) => `${row.project_id}:${row.actor_id}`), [`${projectB1}:rls-matrix-test`]);
    assert.deepEqual(tenantBRows.approvalReminders.map((row) => row.proposal_id), operationalIds(["b1-internal"], "reminder"));
    assert.deepEqual(tenantBRows.integrationEvents.map((row) => row.external_event_id), operationalIds(["b1-internal"], "event"));
    assert.deepEqual(tenantBRows.crossServiceContracts.map((row) => row.contract_id), operationalIds(["b1-internal"], "contract"));
    assert.deepEqual(tenantBRows.runnerQuestions.map((row) => row.question_id), operationalIds(["b1-internal"], "question"));
    assert.deepEqual(tenantBRows.testResults.map((row) => row.test_item_id), operationalIds(["b1-internal"], "test"));
    assert.deepEqual(tenantBRows.repositoryHeads.map((row) => row.repository), [`acme/${operationalMarker("b1-internal")}`]);
    assert.deepEqual(tenantBRows.ingestionHeads, [{ repository: `acme/${operationalMarker("b1-internal")}`, branch: `${operationalMarker("b1-internal")}-branch` }]);
    assert.deepEqual(tenantBRows.notificationOutbox.map((row) => `${row.event_key}:${row.actor_id}`), [`${operationalMarker("b1-internal")}-outbox:rls-matrix-test`]);
    assert.deepEqual(tenantBRows.tokenUsage.map((row) => row.project_id), [projectB1]);
    assert.deepEqual(tenantBRows.syncLocks.map((row) => row.project_id), [projectB1]);

    await assert.rejects(
      app.withRlsTransaction(ctxA, (tx) => tx`INSERT INTO memory_entries (tenant_id, project_id, layer, content, access_policy_id)
        VALUES (${tenantA}, ${projectA1}, 'episodic', ${`${fixturePrefix}-unauthorized-policy-write`}, 'public-org')`),
      /row-level security policy/i,
      "WITH CHECK rejects a write outside the actor's allowed policies"
    );
    await assert.rejects(
      app.withRlsTransaction(ctxA, (tx) => tx`INSERT INTO project_repository_heads (tenant_id, project_id, repository, branch, commit_sha, access_policy_id)
        VALUES (${tenantA}, ${projectA1}, ${`${fixturePrefix}-forbidden/repo`}, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'public-org')`),
      /row-level security policy/i,
      "WITH CHECK rejects repository head writes outside allowed policies"
    );
    await assert.rejects(
      app.withRlsTransaction(ctxA, (tx) => tx`INSERT INTO git_ingestion_heads (tenant_id, project_id, repository, branch, commit_sha, access_policy_id)
        VALUES (${tenantA}, ${projectA1}, ${`${fixturePrefix}-forbidden/repo`}, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'public-org')`),
      /row-level security policy/i,
      "WITH CHECK rejects ingestion checkpoint writes outside allowed policies"
    );
    await assert.rejects(
      app.withRlsTransaction(ctxA, async (tx) => {
        await tx`SELECT set_config('app.current_actor_id', ${ctxA.actorId}, true)`;
        return tx`INSERT INTO notification_outbox (tenant_id, project_id, actor_id, access_policy_id, channel, category, event_key, payload, scheduled_at)
          VALUES (${tenantA}, ${projectA1}, 'other-actor', 'internal-project', 'slack', 'approval', ${`${fixturePrefix}-unauthorized-owner-write`}, ${JSON.stringify({ synthetic: true })}::jsonb, ${dueAt})`;
      }),
      /row-level security policy/i,
      "WITH CHECK rejects writing an outbox row for another actor"
    );
    await assert.rejects(
      app.withRlsTransaction(ctxA, (tx) => tx`INSERT INTO task_leases (tenant_id, project_id, task_id, actor_id, branch, expires_at)
        VALUES (${tenantA}, ${projectB1}, ${`${fixturePrefix}-unauthorized-project-write`}, ${ctxA.actorId}, 'test-branch', ${dueAt})`),
      /row-level security policy/i,
      "WITH CHECK rejects a write to an unauthorized project"
    );
    await assert.rejects(
      app.withRlsTransaction(ctxA, (tx) => tx`INSERT INTO runner_tasks (task_id, tenant_id, project_id, instruction)
        VALUES (${`${fixturePrefix}-unauthorized-tenant-write`}, ${tenantB}, ${projectB1}, 'synthetic unauthorized write')`),
      /row-level security policy/i,
      "WITH CHECK rejects a write to another tenant"
    );
  } finally {
    try {
      await admin`DELETE FROM knowledge_relations WHERE tenant_id IN (${tenantA}, ${tenantB})`;
      await admin`DELETE FROM handoffs WHERE handoff_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM memory_entries WHERE content LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM runner_tasks WHERE task_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM sync_changes WHERE item_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM task_leases WHERE task_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM approval_requests WHERE item_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM context_session_items WHERE session_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM notification_preferences WHERE actor_id IN ('rls-matrix-test', 'other-actor') AND tenant_id IN (${tenantA}, ${tenantB}) AND project_id IN (${projectA1}, ${projectA2}, ${projectB1})`;
      await admin`DELETE FROM policy_epoch_states WHERE actor_id IN ('rls-matrix-test', 'other-actor') AND tenant_id IN (${tenantA}, ${tenantB}) AND project_id IN (${projectA1}, ${projectA2}, ${projectB1})`;
      await admin`DELETE FROM approval_reminder_events WHERE proposal_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM integration_events WHERE external_event_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM cross_service_contracts WHERE contract_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM runner_task_questions WHERE question_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM test_execution_results WHERE test_item_id LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM project_repository_heads WHERE repository LIKE ${`%${fixturePrefix}-%`}`;
      await admin`DELETE FROM git_ingestion_heads WHERE repository LIKE ${`%${fixturePrefix}-%`}`;
      await admin`DELETE FROM notification_outbox WHERE event_key LIKE ${`${fixturePrefix}-%`}`;
      await admin`DELETE FROM runner_token_usage_daily WHERE tenant_id IN (${tenantA}, ${tenantB}) AND project_id IN (${projectA1}, ${projectA2}, ${projectB1})`;
      for (const projectId of [projectA1, projectA2, projectB1]) await admin`DELETE FROM sync_project_locks WHERE tenant_id IN (${tenantA}, ${tenantB}) AND project_id = ${projectId}`;
      for (const id of itemIds) {
        await admin`DELETE FROM knowledge_embeddings WHERE knowledge_item_id = ${id}`;
        await admin`DELETE FROM knowledge_item_versions WHERE item_id = ${id}`;
        await admin`DELETE FROM sync_changes WHERE item_id = ${id}`;
        await admin`DELETE FROM knowledge_items WHERE id = ${id}`;
      }
      await admin`DELETE FROM audit_logs WHERE tenant_id IN (${tenantA}, ${tenantB}) AND target_type = ${auditTargetType}`;
      await admin`DELETE FROM sync_project_locks WHERE tenant_id IN (${tenantA}, ${tenantB})`;
      await admin`DELETE FROM projects WHERE id IN (${projectA1}, ${projectA2}, ${projectB1})`;
      await admin`DELETE FROM organizations WHERE id IN (${tenantA}, ${tenantB})`;
    } finally {
      await app.close();
      await database.client.end();
      await admin.end();
    }
  }
});
