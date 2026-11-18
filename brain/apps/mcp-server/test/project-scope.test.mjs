import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPostgresAuditLogger, InMemoryAuditLogger } from "@brain/audit-engine";
import { createBrainMcpServer, createBrainRuntime, createSqlBrainRuntime } from "../dist/index.js";

function createMemoryRuntime() {
  return createBrainRuntime(new InMemoryAuditLogger());
}

const context = {
  tenantId: "tenant-a",
  actorId: "agent-a",
  actorType: "agent",
  roles: ["developer"],
  allowedProjects: ["allowed-project"],
  allowedPolicies: ["public-org", "internal-project"]
};

async function connectMcp(ctx = context, auditPolicyId = "internal-project") {
  const runtime = createMemoryRuntime();
  const server = createBrainMcpServer(runtime, ctx, auditPolicyId);
  const client = new Client({ name: "scope-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, runtime, server, async close() { await Promise.all([client.close(), server.close()]); } };
}

test("MCP rejects cross-project tool calls", async () => {
  const mcp = await connectMcp();
  try {
    const result = await mcp.client.callTool({
      name: "brain_search",
      arguments: { projectId: "other-project", query: "anything" }
    });
    assert.equal(result.isError, true);
  } finally {
    await mcp.close();
  }
});

test("MCP graph tools traverse from the requested project-qualified origin", async () => {
  const ctx = { ...context, allowedProjects: ["allowed-project", "other-project"] };
  const runtime = createMemoryRuntime();
  runtime.graph.addEdge({
    tenantId: ctx.tenantId,
    fromProjectId: "other-project",
    toProjectId: "other-project",
    fromItemId: "SHARED-ID",
    toItemId: "OTHER-TARGET",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1
  });
  const server = createBrainMcpServer(runtime, ctx, "internal-project");
  const client = new Client({ name: "origin-scope-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({
      name: "brain_find_related_code",
      arguments: { projectId: "allowed-project", targetId: "SHARED-ID" }
    });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(payload.related, []);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP audit policy must be explicitly configured and authorized", () => {
  assert.throws(() => createBrainMcpServer(createMemoryRuntime(), context), /auditPolicyId/);
  assert.throws(() => createBrainMcpServer(createMemoryRuntime(), context, "secret-policy"), /política/);
  assert.throws(() => createBrainMcpServer(createMemoryRuntime(), context, "*"), /auditPolicyId/);
});

test("MCP audit events record the explicitly configured policy", async () => {
  const mcp = await connectMcp();
  try {
    const result = await mcp.client.callTool({
      name: "brain_change_propose",
      arguments: { projectId: "allowed-project", title: "Proposal", content: "Draft" }
    });
    assert.notEqual(result.isError, true);
    assert.equal(mcp.runtime.audit.events[0]?.accessPolicyId, "internal-project");
  } finally {
    await mcp.close();
  }
});

test("MCP runtime requires an explicit audit logger", () => {
  assert.throws(() => createBrainRuntime(), /explicit.*audit logger/i);
});

test("MCP writes events through the PostgreSQL audit logger and trusted RLS context", async () => {
  const transactions = [];
  const fakeAppClient = {
    role: "brain_app",
    async withRlsTransaction(context, callback) {
      transactions.push({ context, inserts: [] });
      const transaction = async (strings, ...parameters) => {
        transactions.at(-1).inserts.push({ sql: strings.join(" ? "), parameters });
      };
      await callback(transaction);
    },
    async close() {}
  };
  const rlsContext = {
    tenantId: context.tenantId,
    allowedProjects: context.allowedProjects,
    allowedPolicies: context.allowedPolicies
  };
  const auditLogger = createPostgresAuditLogger(fakeAppClient, rlsContext);
  const runtime = createBrainRuntime(auditLogger);
  const server = createBrainMcpServer(runtime, context, "internal-project");
  const client = new Client({ name: "postgres-audit-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({
      name: "brain_change_propose",
      arguments: { projectId: "allowed-project", title: "Proposal", content: "Draft" }
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(transactions[0]?.context, rlsContext);
    assert.equal(transactions[0]?.inserts.length, 1);
    assert.match(transactions[0]?.inserts[0]?.sql ?? "", /INSERT INTO audit_logs/);
    assert.ok(transactions[0]?.inserts[0]?.parameters.includes("internal-project"));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP P2 SQL runtime executes brain_search, brain_context_build, brain_knowledge_get and brain_find_related_code over Postgres stores and enforces policy filtering", async () => {
  const nowIso = "2026-11-16T20:45:00.000Z";
  const itemsTable = [
    {
      id: "BR-SUB-014",
      tenant_id: "tenant-a",
      project_id: "allowed-project",
      domain_id: 2,
      type: "business_rule",
      title: "Cancelamento de assinatura",
      content: "Cliente autorizado pode cancelar assinatura.",
      summary: "Regra confidencial de cancelamento.",
      status: "approved",
      source_id: "git",
      source_origin: "internal",
      source_kind: "git",
      source_version: "v2",
      source_uri: ".brain/01-business/BR-SUB-014.yaml",
      version: 2,
      content_hash: "h-br-014",
      owner_id: "billing",
      confidence: 1.0,
      trust_level: "verified",
      is_inferred: false,
      valid_from: nowIso,
      valid_until: null,
      tags: ["cancelamento"],
      access_policy_id: "confidential-business",
      metadata: {},
      deleted_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      lexical_rank: 0.92
    }
  ];

  const relationsTable = [
    {
      tenant_id: "tenant-a",
      from_project_id: "allowed-project",
      to_project_id: "allowed-project",
      from_item_id: "BR-SUB-014",
      to_item_id: "SVC-CANCEL",
      from_policy_id: "confidential-business",
      to_policy_id: "confidential-business",
      relation_type: "GOVERNED_BY",
      is_inferred: false,
      confidence: 1.0
    }
  ];

  const auditLogsTable = [];

  const fakeAppClient = {
    role: "brain_app",
    async withRlsTransaction(rlsCtx, callback) {
      const allowedProjects = new Set(rlsCtx.allowedProjects);
      const allowedPolicies = new Set(rlsCtx.allowedPolicies);

      const tx = async (strings, ...parameters) => {
        const sql = strings.join(" ? ");
        if (sql.includes("INSERT INTO audit_logs")) {
          auditLogsTable.push({ sql, parameters });
          return [];
        }
        if (sql.includes("FROM knowledge_items")) {
          return itemsTable.filter(
            (row) =>
              row.tenant_id === rlsCtx.tenantId &&
              allowedProjects.has(row.project_id) &&
              allowedPolicies.has(row.access_policy_id)
          );
        }
        if (sql.includes("WITH RECURSIVE")) {
          const originItem = parameters[2];
          return relationsTable
            .filter(
              (kr) =>
                kr.tenant_id === rlsCtx.tenantId &&
                allowedProjects.has(kr.from_project_id) &&
                allowedProjects.has(kr.to_project_id) &&
                allowedPolicies.has(kr.from_policy_id) &&
                allowedPolicies.has(kr.to_policy_id) &&
                (kr.from_item_id === originItem || kr.to_item_id === originItem)
            )
            .map((kr) => ({
              root_project_id: kr.from_project_id,
              project_id: kr.from_item_id === originItem ? kr.to_project_id : kr.from_project_id,
              item_id: kr.from_item_id === originItem ? kr.to_item_id : kr.from_item_id,
              hops: 1,
              via: kr.relation_type,
              is_inferred: kr.is_inferred
            }));
        }
        return [];
      };

      return await callback(tx);
    },
    async close() {}
  };

  // 1. Authorized session (includes 'confidential-business' policy)
  const authorizedCtx = {
    tenantId: "tenant-a",
    actorId: "agent-a",
    actorType: "agent",
    roles: ["developer"],
    allowedProjects: ["allowed-project"],
    allowedPolicies: ["internal-project", "confidential-business"]
  };
  const authorizedRls = {
    tenantId: authorizedCtx.tenantId,
    allowedProjects: authorizedCtx.allowedProjects,
    allowedPolicies: authorizedCtx.allowedPolicies
  };

  const sqlRuntimeAuth = createSqlBrainRuntime(fakeAppClient, authorizedRls);
  const serverAuth = createBrainMcpServer(sqlRuntimeAuth, authorizedCtx, "internal-project");
  const clientAuth = new Client({ name: "p2-sql-auth", version: "1.0.0" }, { capabilities: {} });
  const [cTrans1, sTrans1] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientAuth.connect(cTrans1), serverAuth.connect(sTrans1)]);

  try {
    const searchRes = await clientAuth.callTool({
      name: "brain_search",
      arguments: { projectId: "allowed-project", query: "cancelamento" }
    });
    const searchData = JSON.parse(searchRes.content[0].text);
    assert.equal(searchData.items.length, 1);
    assert.equal(searchData.items[0].id, "BR-SUB-014");

    const ctxRes = await clientAuth.callTool({
      name: "brain_context_build",
      arguments: { projectId: "allowed-project", task: "Implementar cancelamento de assinatura", explain: true }
    });
    const ctxData = JSON.parse(ctxRes.content[0].text);
    assert.equal(ctxData.context.businessRules.length, 1);
    assert.equal(ctxData.context.businessRules[0].id, "BR-SUB-014");
    assert.equal(auditLogsTable.length, 1);

    const getRes = await clientAuth.callTool({
      name: "brain_knowledge_get",
      arguments: { projectId: "allowed-project", id: "BR-SUB-014" }
    });
    const getData = JSON.parse(getRes.content[0].text);
    assert.equal(getData.item.id, "BR-SUB-014");
    assert.equal(getData.relations.length, 1);
    assert.equal(getData.relations[0].itemId, "SVC-CANCEL");

    const relRes = await clientAuth.callTool({
      name: "brain_find_related_code",
      arguments: { projectId: "allowed-project", targetId: "BR-SUB-014" }
    });
    const relData = JSON.parse(relRes.content[0].text);
    assert.equal(relData.related.length, 1);
    assert.equal(relData.related[0].itemId, "SVC-CANCEL");
  } finally {
    await Promise.all([clientAuth.close(), serverAuth.close()]);
  }

  // 2. Session without 'confidential-business' in allowedPolicies receives empty / not found
  const restrictedCtx = {
    tenantId: "tenant-a",
    actorId: "agent-b",
    actorType: "agent",
    roles: ["developer"],
    allowedProjects: ["allowed-project"],
    allowedPolicies: ["internal-project"]
  };
  const restrictedRls = {
    tenantId: restrictedCtx.tenantId,
    allowedProjects: restrictedCtx.allowedProjects,
    allowedPolicies: restrictedCtx.allowedPolicies
  };

  const sqlRuntimeRestricted = createSqlBrainRuntime(fakeAppClient, restrictedRls);
  const serverRestricted = createBrainMcpServer(sqlRuntimeRestricted, restrictedCtx, "internal-project");
  const clientRestricted = new Client({ name: "p2-sql-restricted", version: "1.0.0" }, { capabilities: {} });
  const [cTrans2, sTrans2] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientRestricted.connect(cTrans2), serverRestricted.connect(sTrans2)]);

  try {
    const searchDenied = JSON.parse(
      (
        await clientRestricted.callTool({
          name: "brain_search",
          arguments: { projectId: "allowed-project", query: "cancelamento" }
        })
      ).content[0].text
    );
    assert.deepEqual(searchDenied.items, []);

    const ctxDenied = JSON.parse(
      (
        await clientRestricted.callTool({
          name: "brain_context_build",
          arguments: { projectId: "allowed-project", task: "Implementar cancelamento de assinatura" }
        })
      ).content[0].text
    );
    assert.deepEqual(ctxDenied.context.businessRules, []);

    const getDenied = JSON.parse(
      (
        await clientRestricted.callTool({
          name: "brain_knowledge_get",
          arguments: { projectId: "allowed-project", id: "BR-SUB-014" }
        })
      ).content[0].text
    );
    assert.equal(getDenied.error, "BRAIN_ERR_NOT_FOUND");

    const relDenied = JSON.parse(
      (
        await clientRestricted.callTool({
          name: "brain_find_related_code",
          arguments: { projectId: "allowed-project", targetId: "BR-SUB-014" }
        })
      ).content[0].text
    );
    assert.deepEqual(relDenied.related, []);
  } finally {
    await Promise.all([clientRestricted.close(), serverRestricted.close()]);
  }
});
