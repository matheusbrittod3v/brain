import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppPostgresClient } from "../../packages/database/dist/src/client.js";
import { createSqlBrainRuntime, createBrainMcpServer } from "../../apps/mcp-server/dist/index.js";

const rootUrl = process.env.BRAIN_INTEGRATION_DB_URL;

test("SQL MCP proposal is searchable and pending in PostgreSQL after tool success", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.BRAIN_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantId = `mcp-live-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const actorId = "mcp-postgres-integration";
  const proposalId = { value: undefined };
  const app = createAppPostgresClient({ databaseUrl: appUrl });
  const context = {
    tenantId, actorId, actorType: "agent", roles: ["developer"],
    allowedProjects: [projectId], allowedPolicies: ["internal-project"]
  };
  const runtime = createSqlBrainRuntime(app, {
    tenantId, allowedProjects: [projectId], allowedPolicies: ["internal-project"]
  });
  const server = createBrainMcpServer(runtime, context, "internal-project");
  const client = new Client({ name: "postgres-mcp-proposal-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic MCP proposal integration')`;
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const response = await client.callTool({
      name: "brain_change_propose",
      arguments: { projectId, title: "MCP SQL proposal fixture", content: "This draft must survive a runtime restart." }
    });
    assert.notEqual(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    proposalId.value = payload.proposalId;
    assert.equal(payload.status, "draft");

    const persisted = await runtime.retrieval.getItem(context, projectId, payload.proposalId);
    assert.equal(persisted?.title, "MCP SQL proposal fixture");
    assert.equal(persisted?.status, "draft");
    const versions = await runtime.knowledge.listVersions(context, projectId, payload.proposalId);
    assert.equal(versions.length, 1, "the draft has a durable initial version");
    const approvals = await runtime.approvals.listPending(context, projectId);
    assert.ok(approvals.some((approval) => approval.proposalId === payload.proposalId), "the proposal remains in the durable human review queue");
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    try {
      if (proposalId.value) {
        await admin`DELETE FROM approval_requests WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND proposal_id = ${proposalId.value}`;
        await admin`DELETE FROM audit_logs WHERE tenant_id = ${tenantId} AND target_id = ${proposalId.value}`;
        await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND item_id = ${proposalId.value}`;
        await admin`DELETE FROM sync_changes WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND item_id = ${proposalId.value}`;
        await admin`DELETE FROM knowledge_items WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${proposalId.value}`;
      }
      await admin`DELETE FROM sync_project_locks WHERE tenant_id = ${tenantId} AND project_id = ${projectId}`;
      await admin`DELETE FROM organizations WHERE id = ${tenantId}`;
    } finally {
      await app.close();
      await admin.end();
    }
  }
});
