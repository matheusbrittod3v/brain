import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import PgBoss from "pg-boss";
import { createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgKnowledgeRepository } from "../../packages/database/dist/src/repositories.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";
import { processGitIngestJob, processSaasIngestJob } from "../../apps/worker/dist/src/index.js";

const rootUrl = process.env.NOEMA_INTEGRATION_DB_URL;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("live pg-boss worker ingests synthetic Git/SaaS records, scopes and audits embeddings, and shuts down cleanly", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const systemUrl = process.env.DATABASE_SYSTEM_URL ?? rootUrl;
  const appUrl = process.env.NOEMA_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const projectId = `worker-saas-${randomUUID()}`;
  const foreignProjectId = `worker-saas-foreign-${randomUUID()}`;
  const publicItemId = `JIRA-LIVE-${randomUUID()}`;
  const privateItemId = `SLACK-LIVE-${randomUUID()}`;
  const outOfScopeItemId = `JIRA-OUTSIDE-${randomUUID()}`;
  const gitRuleId = `BR-GIT-LIVE-${randomUUID()}`;
  const gitOutOfScopeRuleId = `BR-GIT-OUTSIDE-${randomUUID()}`;
  const approvalProposalId = `APPROVAL-LIVE-${randomUUID()}`;
  const approvalItemId = `APPROVAL-ITEM-${randomUUID()}`;
  const approvalDueAt = new Date(Date.now() + 60_000);
  const notificationActorId = `notification-actor-${randomUUID()}`;
  const notificationEventKey = `notification-event-${randomUUID()}`;
  const notificationGroupKey = `notification-group-${randomUUID()}`;
  const notificationScheduledAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const memoryInScope = `expired-in-scope-${randomUUID()}`;
  const memoryOutOfScope = `expired-out-of-scope-${randomUUID()}`;
  const relationInScope = `relation-in-scope-${randomUUID()}`;
  const relationOutOfScope = `relation-out-of-scope-${randomUUID()}`;
  const gitCommitSha = "d".repeat(40);
  const gitWorkspace = mkdtempSync(join(tmpdir(), "noema-worker-git-live-"));
  mkdirSync(join(gitWorkspace, ".brain/01-business"), { recursive: true });
  writeFileSync(join(gitWorkspace, `.brain/01-business/${gitRuleId}.yaml`), [
    `id: ${gitRuleId}`, "type: business_rule", "title: Synthetic restricted Git rule", "status: draft",
    "access_policy: restricted-security", "description: A private rule ingested by the live worker test."
  ].join("\n"), "utf8");
  writeFileSync(join(gitWorkspace, `.brain/01-business/${gitOutOfScopeRuleId}.yaml`), [
    `id: ${gitOutOfScopeRuleId}`, "type: business_rule", "title: Out-of-scope policy rule", "status: draft",
    "access_policy: external-policy-not-in-job-scope", "description: This record must be rejected."
  ].join("\n"), "utf8");
  mkdirSync(join(gitWorkspace, "src"), { recursive: true });
  mkdirSync(join(gitWorkspace, ".scip"), { recursive: true });
  writeFileSync(join(gitWorkspace, "src/dog.ts"), "export class Dog {}\n", "utf8");
  writeFileSync(join(gitWorkspace, "src/animal.ts"), "export interface Animal {}\n", "utf8");
  const liveScipIndex = {
    metadata: { toolInfo: "scip-typescript live-test", projectRoot: "" },
    documents: [
      { relativePath: "src/dog.ts", language: "typescript", occurrences: [{ symbol: "live Dog#", range: [0, 13, 16], role: "definition" }], symbols: [{
        symbol: "live Dog#", displayName: "Dog", kind: 12, documentation: ["A dog."], enclosingSymbol: "",
        relationships: [{ symbol: "live Animal#", isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }]
      }] },
      { relativePath: "src/animal.ts", language: "typescript", occurrences: [{ symbol: "live Animal#", range: [0, 18, 24], role: "definition" }], symbols: [{
        symbol: "live Animal#", displayName: "Animal", kind: 12, documentation: ["An animal."], enclosingSymbol: "", relationships: []
      }] }
    ]
  };
  writeFileSync(join(gitWorkspace, ".scip/index.scip"), JSON.stringify(liveScipIndex), "utf8");
  const saasQueueName = `noema.ingest-saas-live-${randomUUID()}`;
  const pgBossSchema = `worker_saas_live_${randomUUID().replaceAll("-", "_").slice(0, 24)}`;
  const boss = new PgBoss({ connectionString: systemUrl, schema: pgBossSchema });
  const schemaOwner = postgres(systemUrl);
  let child;
  let jobId;
  let childOutput = "";
  const notificationRequests = [];
  const embeddingRequests = [];
  const notificationServer = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/api/embed") {
        const parsedBody = JSON.parse(body);
        embeddingRequests.push(parsedBody);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: parsedBody.model, embeddings: [new Array(1024).fill(0.01)] }));
        return;
      }
      if (request.url === "/redact-pii") {
        const parsedBody = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ redacted_text: parsedBody.text.replaceAll("jane@example.test", "[EMAIL_REDACTED]") }));
        return;
      }
      notificationRequests.push({ body, idempotencyKey: request.headers["x-noema-idempotency-key"] });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    notificationServer.once("error", rejectListen);
    notificationServer.listen(0, "127.0.0.1", resolveListen);
  });
  const localProviderUrl = `http://127.0.0.1:${notificationServer.address().port}`;
  const notificationWebhookUrl = `${localProviderUrl}/digest`;
  let childClosed;
  const closed = new Promise((resolveClose) => { childClosed = resolveClose; });

  try {
    await admin`INSERT INTO organizations (id, name) VALUES ('default-org', 'Noema Worker SaaS Integration') ON CONFLICT DO NOTHING`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, 'default-org', 'Worker SaaS Integration')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${foreignProjectId}, 'default-org', 'Worker SaaS Foreign Scope')`;
    await boss.start();
    await boss.createQueue(saasQueueName);
    child = spawn(process.execPath, [resolve(repoRoot, "apps/worker/dist/src/index.js")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: appUrl, DATABASE_SYSTEM_URL: systemUrl, NOEMA_PG_BOSS_SCHEMA: pgBossSchema, NOEMA_SAAS_INGEST_QUEUE: saasQueueName, NOEMA_SLACK_WEBHOOK_URL: notificationWebhookUrl, OLLAMA_BASE_URL: localProviderUrl, AI_WORKER_URL: localProviderUrl },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
    child.once("close", (code, signal) => childClosed({ code, signal }));

    await delay(1_500);
    assert.equal(child.exitCode, null, `worker exited before enqueue: ${childOutput}`);
    jobId = await boss.send(saasQueueName, {
      tenantId: "default-org",
      projectId,
      provider: "jira",
      connectionId: "synthetic-nango-connection",
      records: [
        {
          provider: "jira", externalId: publicItemId.slice("JIRA-".length),
          tenantId: "default-org", projectId,
          title: "Synthetic public issue for jane@example.test", body: "Contact jane@example.test about a synthetic retryable invoice issue.",
          url: "https://jira.example.invalid/browse/LIVE", isPrivateChannelOrSpace: false
        },
        {
          provider: "slack", externalId: privateItemId.slice("SLACK-".length),
          tenantId: "default-org", projectId,
          title: "Synthetic private incident", body: "A restricted synthetic incident report.",
          url: "https://slack.example.invalid/archives/private", isPrivateChannelOrSpace: true
        },
        {
          provider: "jira", externalId: outOfScopeItemId.slice("JIRA-".length),
          tenantId: "default-org", projectId: foreignProjectId,
          title: "Out-of-scope synthetic issue", body: "Must not be persisted by this job.",
          url: "https://jira.example.invalid/browse/OUTSIDE", isPrivateChannelOrSpace: false
        }
      ]
    });
    assert.ok(jobId);

    let job;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      job = await boss.getJobById(saasQueueName, jobId);
      if (job?.state === "completed" || job?.state === "failed") break;
      await delay(250);
    }
    assert.equal(job?.state, "completed", `SaaS job did not complete: ${JSON.stringify(job)}\n${childOutput}`);
    assert.equal(job.output?.synced, 2, JSON.stringify(job.output));
    assert.equal(job.output?.errors, 1, `${JSON.stringify(job.output)}\n${childOutput}`);

    const stored = await admin`
      SELECT id, title, content, access_policy_id, status, trust_level, source_kind
      FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
      ORDER BY id
    `;
    assert.deepEqual([...stored], [
      { id: publicItemId, title: "Synthetic public issue for [EMAIL_REDACTED]", content: "Contact [EMAIL_REDACTED] about a synthetic retryable invoice issue.", access_policy_id: "internal-project", status: "draft", trust_level: "untrusted", source_kind: "connector" },
      { id: privateItemId, title: "Synthetic private incident", content: "A restricted synthetic incident report.", access_policy_id: "restricted-security", status: "draft", trust_level: "untrusted", source_kind: "connector" }
    ].sort((a, b) => a.id.localeCompare(b.id)));
    assert.ok(embeddingRequests.every((request) => !JSON.stringify(request).includes("jane@example.test")), "SaaS embeddings never receive the original email");
    const outOfScopeRows = await admin`
      SELECT id FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${foreignProjectId} AND id = ${outOfScopeItemId}
    `;
    assert.equal(outOfScopeRows.length, 0, "the worker rejects a record whose project differs from the queued job scope");
    const journal = await admin`
      SELECT project_id, item_id, access_policy_id FROM sync_changes
      WHERE tenant_id = 'default-org' AND (project_id = ${projectId} OR project_id = ${foreignProjectId})
      ORDER BY project_id, item_id
    `;
    assert.deepEqual([...journal], [
      { project_id: projectId, item_id: publicItemId, access_policy_id: "internal-project" },
      { project_id: projectId, item_id: privateItemId, access_policy_id: "restricted-security" }
    ].sort((a, b) => `${a.project_id}/${a.item_id}`.localeCompare(`${b.project_id}/${b.item_id}`)));
    const auditRows = await admin`
      SELECT project_id, access_policy_id, actor_id, actor_type, action, target_type, target_id, metadata->>'piiRedacted' AS pii_redacted
      FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND metadata->>'source' = 'saas_ingest'
      ORDER BY target_id
    `;
    assert.deepEqual([...auditRows], [
      { project_id: projectId, access_policy_id: "internal-project", actor_id: "noema-worker", actor_type: "system", action: "create", target_type: "knowledge_item", target_id: publicItemId, pii_redacted: "true" },
      { project_id: projectId, access_policy_id: "restricted-security", actor_id: "noema-worker", actor_type: "system", action: "create", target_type: "knowledge_item", target_id: privateItemId, pii_redacted: "false" }
    ].sort((a, b) => a.target_id.localeCompare(b.target_id)));
    const versions = await admin`
      SELECT item_id FROM knowledge_item_versions
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
      ORDER BY item_id
    `;
    assert.deepEqual([...versions].map((row) => row.item_id), [publicItemId, privateItemId].sort());

    await boss.createQueue("noema.embed-item");
    const [embeddingSource] = await admin`
      SELECT source_version, access_policy_id FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${privateItemId}
    `;
    const embeddingRequestCountBeforeJob = embeddingRequests.length;
    const embeddingJobId = await boss.send("noema.embed-item", {
      tenantId: "default-org", projectId, itemId: privateItemId,
      sourceVersion: embeddingSource.source_version,
      accessPolicyId: embeddingSource.access_policy_id,
      content: "Untrusted job payload is ignored; the worker reads the persisted snapshot."
    });
    assert.ok(embeddingJobId);
    let embeddingJob;
    const embeddingDeadline = Date.now() + 25_000;
    while (Date.now() < embeddingDeadline) {
      embeddingJob = await boss.getJobById("noema.embed-item", embeddingJobId);
      if (embeddingJob?.state === "completed" || embeddingJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(embeddingJob?.state, "completed", `Embedding job did not complete: ${JSON.stringify(embeddingJob)}\n${childOutput}`);
    assert.ok(embeddingJob.output?.chunksIndexed > 0, JSON.stringify(embeddingJob.output));
    assert.equal(embeddingRequests.length - embeddingRequestCountBeforeJob, embeddingJob.output.chunksIndexed);
    assert.ok(embeddingRequests.every((request) => request.model === (process.env.EMBEDDING_MODEL ?? "bge-m3")));
    const storedEmbeddings = await admin`
      SELECT access_policy_id, source_version, embedding_model, count(*)::int AS chunks
      FROM knowledge_embeddings
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND knowledge_item_id = ${privateItemId}
      GROUP BY access_policy_id, source_version, embedding_model
    `;
    assert.equal(storedEmbeddings.length, 1);
    assert.deepEqual(storedEmbeddings[0], {
      access_policy_id: "restricted-security", source_version: embeddingSource.source_version,
      embedding_model: process.env.EMBEDDING_MODEL ?? "bge-m3", chunks: embeddingJob.output.chunksIndexed
    });
    const embeddingAudit = await admin`
      SELECT access_policy_id, actor_id, actor_type, action, target_type, target_id, metadata
      FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
        AND metadata->>'source' = 'embed_item' AND target_id = ${privateItemId}
    `;
    assert.equal(embeddingAudit.length, 1);
    assert.deepEqual(embeddingAudit[0], {
      access_policy_id: "restricted-security", actor_id: "noema-worker", actor_type: "system",
      action: "upsert", target_type: "knowledge_embedding", target_id: privateItemId,
      metadata: {
        source: "embed_item", sourceVersion: embeddingSource.source_version,
        chunksIndexed: embeddingJob.output.chunksIndexed, embeddingModel: process.env.EMBEDDING_MODEL ?? "bge-m3"
      }
    });

    await admin`INSERT INTO approval_requests (
      tenant_id, project_id, proposal_id, item_id, domain_id, requested_by, actor_type,
      status, due_at, access_policy_id
    ) VALUES (
      'default-org', ${projectId}, ${approvalProposalId}, ${approvalItemId}, 2,
      'synthetic-reviewer', 'agent', 'pending', ${approvalDueAt}, 'internal-project'
    )`;
    await boss.createQueue("noema.approval-reminder");
    const approvalJobId = await boss.send("noema.approval-reminder", {
      tenantId: "default-org", projectId, proposalId: approvalProposalId,
      accessPolicyId: "internal-project", dueAt: approvalDueAt.toISOString(), eventType: "reminder"
    });
    assert.ok(approvalJobId);
    let approvalJob;
    const approvalDeadline = Date.now() + 25_000;
    while (Date.now() < approvalDeadline) {
      approvalJob = await boss.getJobById("noema.approval-reminder", approvalJobId);
      if (approvalJob?.state === "completed" || approvalJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(approvalJob?.state, "completed", `Approval reminder job did not complete: ${JSON.stringify(approvalJob)}\n${childOutput}`);
    assert.deepEqual(approvalJob.output, { recorded: true });
    const reminderRows = await admin`
      SELECT tenant_id, project_id, proposal_id, access_policy_id, event_type
      FROM approval_reminder_events
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND proposal_id = ${approvalProposalId}
    `;
    assert.deepEqual([...reminderRows], [{
      tenant_id: "default-org", project_id: projectId, proposal_id: approvalProposalId,
      access_policy_id: "internal-project", event_type: "reminder"
    }]);
    const approvalAuditRows = await admin`
      SELECT access_policy_id, actor_id, actor_type, action, target_type, target_id, metadata
      FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
        AND metadata->>'source' = 'approval_reminder' AND target_id = ${approvalProposalId}
    `;
    assert.equal(approvalAuditRows.length, 1);
    assert.equal(approvalAuditRows[0].access_policy_id, "internal-project");
    assert.equal(approvalAuditRows[0].target_type, "approval_reminder");
    assert.equal(approvalAuditRows[0].metadata.inserted, true);

    await admin`INSERT INTO notification_outbox (
      tenant_id, project_id, actor_id, access_policy_id, channel, category, event_key, payload, scheduled_at
    ) VALUES (
      'default-org', ${projectId}, ${notificationActorId}, 'restricted-security', 'slack', 'approval',
      ${notificationEventKey}, ${admin.json({ title: "Synthetic approval", targetId: approvalProposalId })}, ${notificationScheduledAt}
    )`;
    await boss.createQueue("noema.notification-digest");
    const notificationJobId = await boss.send("noema.notification-digest", {
      tenantId: "default-org", projectId, actorId: notificationActorId,
      accessPolicyId: "restricted-security", channel: "slack", category: "approval",
      scheduledAt: notificationScheduledAt.toISOString(), groupKey: notificationGroupKey
    });
    assert.ok(notificationJobId);
    let notificationJob;
    const notificationDeadline = Date.now() + 25_000;
    while (Date.now() < notificationDeadline) {
      notificationJob = await boss.getJobById("noema.notification-digest", notificationJobId);
      if (notificationJob?.state === "completed" || notificationJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(notificationJob?.state, "completed", `Notification digest job did not complete: ${JSON.stringify(notificationJob)}\n${childOutput}`);
    assert.deepEqual(notificationJob.output, { delivered: 1, markedDelivered: 1 });
    assert.equal(notificationRequests.length, 1, "the digest was sent exactly once");
    assert.equal(notificationRequests[0].idempotencyKey, `digest:${notificationGroupKey}`);
    assert.match(JSON.parse(notificationRequests[0].body).text, new RegExp(approvalProposalId));
    const [deliveredNotification] = await admin`
      SELECT access_policy_id, delivered_at FROM notification_outbox
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND actor_id = ${notificationActorId} AND event_key = ${notificationEventKey}
    `;
    assert.equal(deliveredNotification.access_policy_id, "restricted-security");
    assert.ok(deliveredNotification.delivered_at);
    const notificationAuditRows = await admin`
      SELECT access_policy_id, actor_id, actor_type, action, target_type, target_id, metadata
      FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
        AND metadata->>'source' = 'notification_digest' AND target_id = ${notificationGroupKey}
    `;
    assert.equal(notificationAuditRows.length, 1);
    assert.equal(notificationAuditRows[0].access_policy_id, "restricted-security");
    assert.equal(notificationAuditRows[0].actor_id, notificationActorId);
    assert.equal(notificationAuditRows[0].actor_type, "human");

    await admin`INSERT INTO memory_entries (tenant_id, project_id, actor_id, layer, content, access_policy_id, expires_at)
      VALUES
      ('default-org', ${projectId}, 'synthetic-memory-worker', 'episodic', ${memoryInScope}, 'internal-project', now() - interval '1 minute'),
      ('default-org', ${foreignProjectId}, 'synthetic-memory-worker', 'episodic', ${memoryOutOfScope}, 'internal-project', now() - interval '1 minute')`;
    await admin`INSERT INTO knowledge_relations (
      tenant_id, from_project_id, to_project_id, from_item_id, to_item_id, from_policy_id, to_policy_id,
      relation_type, is_inferred, confidence, created_at
    ) VALUES
      ('default-org', ${projectId}, ${projectId}, ${relationInScope}, 'target-in-scope', 'internal-project', 'internal-project', 'DERIVED_TEST', true, 0.5, now() - interval '61 days'),
      ('default-org', ${foreignProjectId}, ${foreignProjectId}, ${relationOutOfScope}, 'target-out-of-scope', 'internal-project', 'internal-project', 'DERIVED_TEST', true, 0.5, now() - interval '61 days')`;
    await boss.createQueue("noema.memory-decay");
    const memoryDecayJobId = await boss.send("noema.memory-decay", {
      tenantId: "default-org", projectId, accessPolicyId: "internal-project"
    });
    assert.ok(memoryDecayJobId);
    let memoryDecayJob;
    const memoryDecayDeadline = Date.now() + 25_000;
    while (Date.now() < memoryDecayDeadline) {
      memoryDecayJob = await boss.getJobById("noema.memory-decay", memoryDecayJobId);
      if (memoryDecayJob?.state === "completed" || memoryDecayJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(memoryDecayJob?.state, "completed", `Memory decay job did not complete: ${JSON.stringify(memoryDecayJob)}\n${childOutput}`);
    const remainingMemory = await admin`
      SELECT project_id, content FROM memory_entries WHERE content IN (${memoryInScope}, ${memoryOutOfScope}) ORDER BY content
    `;
    assert.deepEqual([...remainingMemory], [{ project_id: foreignProjectId, content: memoryOutOfScope }]);
    const remainingRelations = await admin`
      SELECT from_project_id, from_item_id FROM knowledge_relations
      WHERE from_item_id IN (${relationInScope}, ${relationOutOfScope}) ORDER BY from_item_id
    `;
    assert.deepEqual([...remainingRelations], [{ from_project_id: foreignProjectId, from_item_id: relationOutOfScope }]);
    assert.deepEqual(memoryDecayJob.output, { expiredMemoryRemoved: 1, decayedRelationsRemoved: 1, retainedByAccessCount: 0 });
    const memoryDecayAudit = await admin`
      SELECT access_policy_id, action, target_type, metadata FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId}
        AND metadata->>'source' = 'memory_decay'
    `;
    assert.equal(memoryDecayAudit.length, 1);
    assert.equal(memoryDecayAudit[0].access_policy_id, "internal-project");
    assert.equal(memoryDecayAudit[0].metadata.expiredMemoryRemoved, 1);
    assert.equal(memoryDecayAudit[0].metadata.decayedRelationsRemoved, 1);

    await boss.createQueue("noema.ingest-git");
    const gitJobId = await boss.send("noema.ingest-git", {
      tenantId: "default-org", projectId, repoDir: gitWorkspace, commitSha: gitCommitSha,
      accessPolicyId: "internal-project"
    });
    assert.ok(gitJobId);
    let gitJob;
    const gitDeadline = Date.now() + 25_000;
    while (Date.now() < gitDeadline) {
      gitJob = await boss.getJobById("noema.ingest-git", gitJobId);
      if (gitJob?.state === "completed" || gitJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(gitJob?.state, "completed", `Git job did not complete: ${JSON.stringify(gitJob)}\n${childOutput}`);
    assert.equal(gitJob.output?.ingested, 5, JSON.stringify(gitJob.output));
    assert.equal(gitJob.output?.errors, 1, JSON.stringify(gitJob.output));
    const [gitItem] = await admin`
      SELECT id, access_policy_id, source_version, status, trust_level, source_kind
      FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${gitRuleId}
    `;
    assert.deepEqual(gitItem, {
      id: gitRuleId, access_policy_id: "restricted-security", source_version: gitCommitSha,
      status: "draft", trust_level: "verified", source_kind: "git"
    });
    const rejectedGitItems = await admin`
      SELECT id FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND id = ${gitOutOfScopeRuleId}
    `;
    assert.equal(rejectedGitItems.length, 0, "Git ingestion rejects frontmatter policies outside the queued worker scope");
    const gitAuditRows = await admin`
      SELECT access_policy_id, actor_id, actor_type, action, target_type, target_id, metadata
      FROM audit_logs
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND target_id = ${gitRuleId}
    `;
    assert.equal(gitAuditRows.length, 1);
    assert.equal(gitAuditRows[0].access_policy_id, "restricted-security");
    assert.equal(gitAuditRows[0].actor_id, "noema-worker");
    assert.equal(gitAuditRows[0].metadata.source, "git_ingest");
    const liveSymbols = await admin`
      SELECT id, type, source_uri, access_policy_id, metadata
      FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND type = 'code_symbol'
      ORDER BY id
    `;
    assert.equal(liveSymbols.length, 2);
    assert.ok(liveSymbols.every((item) => item.access_policy_id === "internal-project" && item.metadata.source === "scip"));
    const liveScipEdges = await admin`
      SELECT from_item_id, to_item_id, relation_type, metadata, evidence_uri
      FROM knowledge_relations
      WHERE tenant_id = 'default-org' AND from_project_id = ${projectId}
        AND metadata->>'source' = 'scip'
      ORDER BY relation_type, from_item_id, to_item_id
    `;
    assert.equal(liveScipEdges.length, 4, JSON.stringify({ workerOutput: gitJob.output, persistedRelations: await admin`
      SELECT from_item_id, to_item_id, relation_type, evidence_uri, metadata
      FROM knowledge_relations WHERE tenant_id = 'default-org' AND from_project_id = ${projectId}
    ` }));
    assert.ok(liveScipEdges.every((edge) => edge.evidence_uri === ".scip/index.scip"));

    const reindexedScip = {
      ...liveScipIndex,
      documents: liveScipIndex.documents.map((document) => document.relativePath === "src/dog.ts"
        ? { ...document, occurrences: [], symbols: [] }
        : document)
    };
    writeFileSync(join(gitWorkspace, ".scip/index.scip"), JSON.stringify(reindexedScip), "utf8");
    const reindexJobId = await boss.send("noema.ingest-git", {
      tenantId: "default-org", projectId, repoDir: gitWorkspace, commitSha: gitCommitSha,
      accessPolicyId: "internal-project"
    });
    assert.ok(reindexJobId);
    let reindexJob;
    const reindexDeadline = Date.now() + 25_000;
    while (Date.now() < reindexDeadline) {
      reindexJob = await boss.getJobById("noema.ingest-git", reindexJobId);
      if (reindexJob?.state === "completed" || reindexJob?.state === "failed") break;
      await delay(250);
    }
    assert.equal(reindexJob?.state, "completed", `SCIP reindex job did not complete: ${JSON.stringify(reindexJob)}\n${childOutput}`);
    assert.equal(reindexJob.output?.scipSymbolsRetired, 1, JSON.stringify({ output: reindexJob.output, symbols: await admin`
      SELECT id, type, source_kind, deleted_at, metadata FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND type = 'code_symbol'
    ` }));
    const symbolsAfterReindex = await admin`
      SELECT id FROM knowledge_items
      WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND type = 'code_symbol' AND deleted_at IS NULL
    `;
    assert.equal(symbolsAfterReindex.length, 1);
    const edgesAfterReindex = await admin`
      SELECT from_item_id, to_item_id FROM knowledge_relations
      WHERE tenant_id = 'default-org' AND from_project_id = ${projectId} AND metadata->>'source' = 'scip'
    `;
    assert.equal(edgesAfterReindex.length, 1);

    child.kill("SIGTERM");
    const exit = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => rejectExit(new Error(`worker shutdown timed out: ${childOutput}`)), 35_000);
      closed.then((result) => { clearTimeout(timeout); resolveExit(result); });
    });
    assert.deepEqual(exit, { code: 0, signal: null }, `worker did not shut down gracefully: ${childOutput}`);
    assert.match(childOutput, /"event":"worker_shutdown_completed","signal":"SIGTERM"/);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
    if (jobId) await boss.deleteJob(saasQueueName, jobId).catch(() => {});
    await boss.stop({ graceful: false, timeout: 5_000 }).catch(() => {});
    await schemaOwner.unsafe(`DROP SCHEMA IF EXISTS "${pgBossSchema}" CASCADE`);
    await schemaOwner.end();
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = 'default-org' AND (from_project_id = ${projectId} OR to_project_id = ${projectId})`;
    await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM sync_changes WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM approval_reminder_events WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND proposal_id = ${approvalProposalId}`;
    await admin`DELETE FROM approval_requests WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND proposal_id = ${approvalProposalId}`;
    await admin`DELETE FROM notification_outbox WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND actor_id = ${notificationActorId}`;
    await admin`DELETE FROM memory_entries WHERE tenant_id = 'default-org' AND content IN (${memoryInScope}, ${memoryOutOfScope})`;
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = 'default-org' AND from_item_id IN (${relationInScope}, ${relationOutOfScope})`;
    await admin`DELETE FROM audit_logs WHERE tenant_id = 'default-org' AND project_id = ${projectId} AND metadata->>'source' IN ('saas_ingest', 'git_ingest', 'scip_symbol', 'embed_item', 'approval_reminder', 'notification_digest', 'memory_decay')`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = 'default-org' AND (from_project_id = ${foreignProjectId} OR to_project_id = ${foreignProjectId})`;
    await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = 'default-org' AND project_id = ${foreignProjectId}`;
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${foreignProjectId}`;
    await admin`DELETE FROM sync_changes WHERE tenant_id = 'default-org' AND project_id = ${foreignProjectId}`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${foreignProjectId}`;
    await admin`DELETE FROM projects WHERE tenant_id = 'default-org' AND id = ${projectId}`;
    await admin`DELETE FROM projects WHERE tenant_id = 'default-org' AND id = ${foreignProjectId}`;
    rmSync(gitWorkspace, { recursive: true, force: true });
    await new Promise((resolveClose) => notificationServer.close(resolveClose));
    await admin.end();
  }
});

test("live GitHub ingestion bootstraps, renames, deletes, reconciles snapshots, recovers force pushes, and replays with PostgreSQL checkpoints", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const appUrl = process.env.NOEMA_APP_DB_URL ?? `postgresql://brain_app:brain_app_dev_password@${new URL(rootUrl).hostname}:${new URL(rootUrl).port || 5432}${new URL(rootUrl).pathname}`;
  const tenantId = `git-incremental-${randomUUID()}`;
  const projectId = `git-incremental-project-${randomUUID()}`;
  const secondTenantId = `git-incremental-tenant-${randomUUID()}`;
  const secondProjectId = `git-incremental-project-${randomUUID()}`;
  const thirdProjectId = `git-incremental-project-${randomUUID()}`;
  const repository = `synthetic/${randomUUID().replaceAll("-", "")}`;
  const [owner, repoName] = repository.split("/");
  const branch = `feature-${randomUUID().slice(0, 8)}`;
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const shaD = "d".repeat(40);
  const db = createDatabaseClient(appUrl);
  const knowledge = new PgKnowledgeRepository(db.db);
  const operations = new PgOperationalRepository(db.db);
  const ctx = {
    tenantId, actorId: "noema-worker-live-test", actorType: "system", roles: ["system"],
    allowedProjects: [projectId], allowedPolicies: ["internal-project", "restricted-security"]
  };
  let stage = 0;
  const docs = {
    "docs/rule.md": "# Incremental Rule\n\nInitial synthetic content.\n",
    "docs/old-name.md": "# Rename Fixture\n\nThis file will be renamed.\n",
    "docs/snapshot-only.md": "# Snapshot Reconciliation\n\nThis remains until a full snapshot omits it.\n",
    "docs/pii.md": "# Contact\n\nEmail jane@example.test for synthetic support.\n"
  };
  const embeddedInputs = [];
  const fetchFn = async (input) => {
    const url = String(input);
    if (url.endsWith(`/repos/${owner}/${repoName}`)) return new Response(JSON.stringify({ private: true }), { status: 200 });
    if (url.includes("/compare/")) {
      if (stage === 3) return new Response(JSON.stringify({ status: "diverged", files: [] }), { status: 200 });
      const files = stage === 1
        ? [
            { filename: "docs/rule.md", sha: "blob-rule-b", status: "modified" },
            { filename: "docs/new-name.md", sha: "blob-rename-b", status: "renamed", previous_filename: "docs/old-name.md" }
          ]
        : [{ filename: "docs/new-name.md", status: "removed" }, { filename: "docs/rule.md", sha: "blob-rule-c", status: "modified" }];
      return new Response(JSON.stringify({ status: "ahead", files }), { status: 200 });
    }
    if (url.includes("/contents/")) {
      const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      const content = path === "docs/pii.md" ? docs[path] : path === "docs/rule.md"
        ? stage === 1 ? "# Incremental Rule\n\nUpdated synthetic content.\n" : "# Incremental Rule\n\nFinal synthetic content.\n"
        : "# Rename Fixture\n\nRenamed synthetic content.\n";
      return new Response(JSON.stringify({ sha: "blob-content", encoding: "base64", content: Buffer.from(content).toString("base64") }), { status: 200 });
    }
    if (url.includes("/commits/")) return new Response(JSON.stringify({ sha: stage === 0 ? shaA : stage === 1 ? shaB : stage === 2 ? shaC : shaD }), { status: 200 });
    if (url.includes("/git/trees/")) {
      const paths = stage === 0 ? Object.keys(docs) : ["docs/rule.md", ...(stage === 1 ? ["docs/new-name.md"] : [])];
      return new Response(JSON.stringify({ sha: `tree-${stage}`, truncated: false, tree: paths.map((path) => ({ path, type: "blob", sha: `blob-${path}` })) }), { status: 200 });
    }
    throw new Error(`Unexpected synthetic GitHub request: ${url}`);
  };
  const ingestCommit = async (commitSha, beforeCommitSha, targetTenantId = tenantId, targetProjectId = projectId) => processGitIngestJob({
    tenantId: targetTenantId, projectId: targetProjectId, owner, repo: repoName, ref: commitSha, commitSha, beforeCommitSha, branch, accessPolicyId: "internal-project"
  }, knowledge, {
    gitState: operations,
    retireGitSources: knowledge.retireGitSources.bind(knowledge),
    retireGitSourcesExcept: knowledge.retireGitSourcesExcept.bind(knowledge),
    embedFn: async (text) => { embeddedInputs.push(text); return new Array(1024).fill(0.01); },
    piiRedactFn: async (text) => text.replaceAll("jane@example.test", "[EMAIL_REDACTED]"),
    fetchFn
  });

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic Git Incremental Tenant')`;
    await admin`INSERT INTO organizations (id, name) VALUES (${secondTenantId}, 'Synthetic Git Incremental Second Tenant')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, ${tenantId}, 'Synthetic Git Incremental Project')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${secondProjectId}, ${tenantId}, 'Synthetic Git Incremental Second Project')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${thirdProjectId}, ${secondTenantId}, 'Synthetic Git Incremental Third Project')`;
    const first = await ingestCommit(shaA, undefined);
    assert.equal(first.ingestionMode, "full");
    assert.equal(first.checkpointAdvanced, true);
    assert.equal(first.ingested, 4);
    const firstItems = await admin`SELECT id, source_uri, title, content, version, deleted_at FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} ORDER BY source_uri`;
    assert.equal(firstItems.length, 4);
    const originalPath = firstItems.find((item) => item.source_uri === "docs/old-name.md");
    const snapshotOnly = firstItems.find((item) => item.source_uri === "docs/snapshot-only.md");
    const ruleItem = firstItems.find((item) => item.source_uri === "docs/rule.md");
    assert.ok(originalPath && snapshotOnly && ruleItem);
    const piiItem = firstItems.find((item) => item.source_uri === "docs/pii.md");
    assert.ok(piiItem);
    assert.doesNotMatch(`${piiItem.title}\n${piiItem.content}`, /jane@example\.test/);
    assert.match(piiItem.content, /\[EMAIL_REDACTED\]/);
    assert.ok(embeddedInputs.some((input) => input.includes("[EMAIL_REDACTED]")));
    assert.ok(embeddedInputs.every((input) => !input.includes("jane@example.test")));
    const [checkpointA] = await admin`SELECT commit_sha FROM git_ingestion_heads WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND repository = ${repository} AND branch = ${branch}`;
    assert.equal(checkpointA.commit_sha, shaA);

    stage = 1;
    const renamed = await ingestCommit(shaB, shaA);
    assert.equal(renamed.ingestionMode, "incremental");
    assert.equal(renamed.checkpointAdvanced, true);
    const afterRename = await admin`SELECT id, source_uri, version, deleted_at FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} ORDER BY source_uri`;
    assert.equal(afterRename.find((item) => item.id === originalPath.id).deleted_at instanceof Date, true);
    assert.ok(afterRename.some((item) => item.source_uri === "docs/new-name.md" && item.deleted_at === null));
    assert.equal(afterRename.find((item) => item.id === ruleItem.id).version, 2);
    const [activeRuleEmbeddings] = await admin`SELECT count(*)::int AS count FROM knowledge_embeddings WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND knowledge_item_id = ${ruleItem.id}`;
    assert.ok(activeRuleEmbeddings.count > 0);
    const [retiredOldEmbeddings] = await admin`SELECT count(*)::int AS count FROM knowledge_embeddings WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND knowledge_item_id = ${originalPath.id}`;
    assert.equal(retiredOldEmbeddings.count, 0);
    const [snapshotOnlyBeforeRecovery] = await admin`SELECT deleted_at FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${snapshotOnly.id}`;
    assert.equal(snapshotOnlyBeforeRecovery.deleted_at, null, "the changed-file diff leaves untouched sources active");

    stage = 2;
    const deleted = await ingestCommit(shaC, shaB);
    assert.equal(deleted.ingestionMode, "incremental");
    assert.equal(deleted.checkpointAdvanced, true);
    const finalItems = await admin`SELECT id, source_uri, version, deleted_at FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
    assert.ok(finalItems.find((item) => item.source_uri === "docs/new-name.md").deleted_at instanceof Date);
    assert.equal(finalItems.find((item) => item.id === ruleItem.id).version, 3);
    stage = 3;
    const forcePushed = await ingestCommit(shaD, shaC);
    assert.equal(forcePushed.ingestionMode, "full", "a diverged force push falls back to a full snapshot");
    assert.equal(forcePushed.checkpointAdvanced, true);
    const [forcePushRule] = await admin`SELECT version FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${ruleItem.id}`;
    assert.equal(forcePushRule.version, 3, "unchanged content does not create a duplicate item version during force-push recovery");
    const [retiredSnapshotOnly] = await admin`SELECT deleted_at FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${snapshotOnly.id}`;
    assert.ok(retiredSnapshotOnly.deleted_at instanceof Date, "full-snapshot recovery retires sources absent from the tree");
    const [snapshotOnlyEmbeddings] = await admin`SELECT count(*)::int AS count FROM knowledge_embeddings WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND knowledge_item_id = ${snapshotOnly.id}`;
    assert.equal(snapshotOnlyEmbeddings.count, 0);
    const forcePushEmbeddings = await admin`SELECT DISTINCT source_version FROM knowledge_embeddings WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND knowledge_item_id = ${ruleItem.id} ORDER BY source_version`;
    assert.ok(forcePushEmbeddings.some((row) => row.source_version === shaC));
    assert.ok(!forcePushEmbeddings.some((row) => row.source_version === shaD), "unchanged content reuses its persisted item version for derived vectors");
    const replay = await ingestCommit(shaD, shaC);
    assert.equal(replay.ingestionMode, "full", "a repeated current commit performs a repair snapshot");
    const [versionCount] = await admin`SELECT count(*)::int AS count FROM knowledge_item_versions WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND item_id = ${ruleItem.id}`;
    assert.equal(versionCount.count, 3, "replaying an unchanged commit does not create duplicate item versions");
    const [checkpointD] = await admin`SELECT commit_sha FROM git_ingestion_heads WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND repository = ${repository} AND branch = ${branch}`;
    assert.equal(checkpointD.commit_sha, shaD);

    stage = 0;
    const secondProjectImport = await ingestCommit(shaA, undefined, tenantId, secondProjectId);
    const secondTenantImport = await ingestCommit(shaA, undefined, secondTenantId, thirdProjectId);
    assert.equal(secondProjectImport.ingestionMode, "full");
    assert.equal(secondTenantImport.ingestionMode, "full");
    const scopedHashes = await admin`SELECT tenant_id, project_id, content_hash FROM knowledge_items WHERE id = ${ruleItem.id} AND source_uri = 'docs/rule.md' ORDER BY tenant_id, project_id`;
    assert.equal(scopedHashes.length, 3);
    assert.equal(new Set(scopedHashes.map((row) => row.content_hash)).size, 1, "the same source URI/content hash remains independently scoped to each project and tenant");
  } finally {
    for (const [cleanupTenantId, cleanupProjectId] of [[tenantId, projectId], [tenantId, secondProjectId], [secondTenantId, thirdProjectId]]) {
      await admin`DELETE FROM git_ingestion_heads WHERE tenant_id = ${cleanupTenantId} AND project_id = ${cleanupProjectId}`;
      await admin`DELETE FROM knowledge_relations WHERE tenant_id = ${cleanupTenantId} AND (from_project_id = ${cleanupProjectId} OR to_project_id = ${cleanupProjectId})`;
      await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = ${cleanupTenantId} AND project_id = ${cleanupProjectId}`;
      await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${cleanupTenantId} AND project_id = ${cleanupProjectId}`;
      await admin`DELETE FROM sync_changes WHERE tenant_id = ${cleanupTenantId} AND project_id = ${cleanupProjectId}`;
      await admin`DELETE FROM knowledge_items WHERE tenant_id = ${cleanupTenantId} AND project_id = ${cleanupProjectId}`;
      await admin`DELETE FROM projects WHERE tenant_id = ${cleanupTenantId} AND id = ${cleanupProjectId}`;
    }
    await admin`DELETE FROM organizations WHERE id = ${tenantId}`;
    await admin`DELETE FROM organizations WHERE id = ${secondTenantId}`;
    await db.client.end();
    await admin.end();
  }
});
