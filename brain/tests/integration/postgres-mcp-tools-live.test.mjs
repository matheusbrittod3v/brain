import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppPostgresClient, createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";
import { parseKnowledgeFile } from "../../packages/knowledge/dist/src/index.js";
import { createBrainMcpServer, createSqlBrainRuntime } from "../../apps/mcp-server/dist/index.js";

const rootUrl = process.env.BRAIN_INTEGRATION_DB_URL;

test("all 13 SQL MCP tools operate against PostgreSQL and durable results survive a runtime restart", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.BRAIN_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantId = `mcp-tools-live-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const actorId = `mcp-live-${randomUUID()}`;
  const ruleId = `RULE-${randomUUID()}`;
  const codeId = `CODE-${randomUUID()}`;
  const proposalPrefix = "PROP-";
  const workspace = mkdtempSync(join(tmpdir(), "brain-mcp-tools-live-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "invoice.ts"), "export function invoiceLimit(value: number) { return Math.min(value, 25); }\n", "utf8");
  const app = createAppPostgresClient({ databaseUrl: appUrl });
  const operationalDb = createDatabaseClient(appUrl);
  const opRepo = new PgOperationalRepository(operationalDb.db);
  const authContext = {
    tenantId, actorId, actorType: "agent", roles: ["developer"],
    allowedProjects: [projectId], allowedPolicies: ["internal-project"]
  };
  const rlsContext = { tenantId, allowedProjects: [projectId], allowedPolicies: ["internal-project"] };
  const runtime = createSqlBrainRuntime(app, rlsContext, undefined, { workspaceRoot: workspace, opRepo });
  const server = createBrainMcpServer(runtime, authContext, "internal-project");
  const client = new Client({ name: "postgres-mcp-tools-live", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let proposalId;
  let handoffId;
  const taskId = `runner-${randomUUID()}`;
  const sessionId = `mcp-session-${randomUUID()}`;
  const memorySummary = `SQL MCP memory ${randomUUID()}`;

  const callTool = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name} failed: ${response.content?.[0]?.text}`);
    return JSON.parse(response.content[0].text);
  };

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic SQL MCP tools')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, ${tenantId}, 'Synthetic SQL MCP tools')`;
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const rule = parseKnowledgeFile({
      tenantId, projectId, filePath: `.brain/01-business/${ruleId}.md`, commitSha: "a".repeat(40),
      rawContent: `---\nid: ${ruleId}\ntitle: Invoice limit rule\ntype: business_rule\nstatus: approved\naccess_policy: internal-project\ntags: [billing]\n---\n\nInvoice limit must remain at or below 25.\n`
    });
    const code = parseKnowledgeFile({
      tenantId, projectId, filePath: "src/invoice.ts", commitSha: "a".repeat(40),
      rawContent: `---\nid: ${codeId}\ntitle: Invoice limit implementation\ntype: code_symbol\nstatus: approved\naccess_policy: internal-project\n---\n\nexport function invoiceLimit(value: number) { return Math.min(value, 25); }\n`
    });
    await runtime.knowledge.upsertItem(authContext, rule);
    await runtime.knowledge.upsertItem(authContext, code);
    await runtime.graph.addEdge({
      tenantId, fromProjectId: projectId, toProjectId: projectId,
      fromItemId: ruleId, toItemId: codeId,
      fromPolicyId: "internal-project", toPolicyId: "internal-project",
      relationType: "IMPLEMENTS", isInferred: false, confidence: 1
    });

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 13);
    const bootstrap = await callTool("brain_bootstrap_project", { projectId });
    assert.equal(bootstrap.projectId, projectId);
    const context = await callTool("brain_context_build", { projectId, task: "invoice limit billing rule", intent: "review", sessionId, tokenBudget: 1200 });
    assert.equal(context.sessionId, sessionId);
    assert.ok(Array.isArray(context.sources));
    const search = await callTool("brain_search", { projectId, query: "invoice limit", limit: 10 });
    assert.ok(search.items.some((item) => item.id === ruleId));
    const fetched = await callTool("brain_knowledge_get", { projectId, id: ruleId, version: 1 });
    assert.equal(fetched.item.id, ruleId);
    const activeRules = await callTool("brain_get_active_rules", { projectId, query: "invoice limit", tags: ["billing"] });
    assert.ok(activeRules.rules.some((item) => item.id === ruleId));
    const related = await callTool("brain_find_related_code", { projectId, targetId: ruleId });
    assert.ok(related.related.some((item) => item.itemId === codeId));
    const impact = await callTool("brain_analyze_change_impact", { projectId, targetIds: [codeId] });
    assert.ok(impact.directImpacts.some((item) => item.itemId === ruleId) || impact.transitiveImpacts.some((item) => item.itemId === ruleId));
    const validation = await callTool("brain_validate_implementation", { projectId, paths: ["src/invoice.ts"], mode: "audit" });
    assert.equal(validation.checkedPaths[0], "src/invoice.ts");

    const handoff = await callTool("brain_create_handoff", {
      projectId, taskId, branch: "feature/sql-mcp", baseCommitSha: "a".repeat(40), nextSteps: ["Resume from SQL"]
    });
    handoffId = handoff.handoffId;
    assert.ok(handoffId);
    const learning = await callTool("brain_record_learning", { projectId, summary: memorySummary });
    assert.equal(learning.recorded, true);
    const proposal = await callTool("brain_change_propose", { projectId, title: "Synthetic SQL proposal", content: "Durable proposal body", targetType: "business_rule" });
    proposalId = proposal.proposalId;
    assert.equal(proposal.status, "draft");
    const delegated = await callTool("brain_delegate_task", { projectId, instruction: "Synthetic durable MCP task", priority: "high" });
    assert.equal(delegated.status, "queued");

    await client.close();
    await server.close();
    const restartedRuntime = createSqlBrainRuntime(app, rlsContext, undefined, { workspaceRoot: workspace, opRepo });
    const restartedServer = createBrainMcpServer(restartedRuntime, authContext, "internal-project");
    const restartedClient = new Client({ name: "postgres-mcp-tools-restarted", version: "1.0.0" }, { capabilities: {} });
    const [restartedClientTransport, restartedServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([restartedClient.connect(restartedClientTransport), restartedServer.connect(restartedServerTransport)]);
    try {
      const resumed = await restartedClient.callTool({ name: "brain_resume_handoff", arguments: { projectId, handoffId, currentBranch: "feature/sql-mcp", currentCommitSha: "a".repeat(40) } });
      assert.notEqual(resumed.isError, true);
      assert.ok(JSON.parse(resumed.content[0].text).handoff);
      assert.equal((await restartedRuntime.retrieval.getItem(authContext, projectId, proposalId))?.title, "Synthetic SQL proposal");
      const tasks = await restartedRuntime.opRepo.listRunnerTasks(authContext, projectId, 20);
      assert.ok(tasks.some((task) => task.instruction === "Synthetic durable MCP task"));
      const memories = await admin`SELECT content FROM memory_entries WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND content = ${memorySummary}`;
      assert.equal(memories.length, 1);
    } finally {
      await Promise.allSettled([restartedClient.close(), restartedServer.close()]);
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    try {
      await admin`DELETE FROM approval_requests WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM runner_tasks WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM handoffs WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM task_leases WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM memory_entries WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM context_session_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM knowledge_relations WHERE tenant_id = ${tenantId} AND (from_project_id = ${projectId} OR to_project_id = ${projectId})`;
      await admin`DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM sync_changes WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM sync_project_locks WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM projects WHERE tenant_id = ${tenantId} AND id = ${projectId}`;
      await admin`DELETE FROM organizations WHERE id = ${tenantId}`;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      await operationalDb.client.end();
      await app.close();
      await admin.end();
    }
  }
});
