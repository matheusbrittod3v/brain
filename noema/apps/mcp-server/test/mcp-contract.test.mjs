import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { createNoemaMcpServer, createNoemaRuntime } from "../dist/index.js";

const context = {
  tenantId: "tenant-a", actorId: "agent-a", actorType: "agent", roles: ["developer"],
  allowedProjects: ["allowed-project"], allowedPolicies: ["public-org", "internal-project"]
};

async function openMcp(runtime, customCtx = context, profile = "service") {
  const server = createNoemaMcpServer(runtime, customCtx, "internal-project", profile);
  const client = new Client({ name: "mcp-contract-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("stdio MCP catalog exposes the canonical 58 tools", async () => {
  const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../protocols/mcp-tools/catalog.json", import.meta.url)), "utf8"));
  const { client, server } = await openMcp(createNoemaRuntime(new InMemoryAuditLogger()));
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), catalog);
    assert.equal(listed.tools.length, 58);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("service and local MCP tool descriptions explain their connection and data boundaries", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const service = await openMcp(runtime, context, "service");
  const local = await openMcp(runtime, context, "local");
  try {
    const serviceTools = await service.client.listTools();
    const localTools = await local.client.listTools();
    assert.equal(service.client.getServerVersion().name, "noema-brain-service");
    assert.equal(local.client.getServerVersion().name, "noema-brain-local");
    assert.equal(serviceTools.tools.every((tool) => tool.description.startsWith("[Noema principal · MCP HTTP conectado:")), true);
    assert.equal(localTools.tools.every((tool) => tool.description.startsWith("[Noema local · MCP stdio:")), true);
    const serviceDescription = serviceTools.tools.find((tool) => tool.name === "brain_bootstrap_project").description;
    const localDescription = localTools.tools.find((tool) => tool.name === "brain_bootstrap_project").description;
    assert.match(serviceDescription, /Noema principal.*MCP HTTP conectado/i);
    assert.match(serviceDescription, /não presuma.*banco/i);
    assert.match(localDescription, /Noema local.*stdio/i);
    assert.match(localDescription, /DATABASE_URL/i);
    assert.match(localDescription, /pode apontar para o mesmo banco/i);
    assert.notEqual(serviceDescription, localDescription);
  } finally {
    await Promise.all([service.client.close(), service.server.close(), local.client.close(), local.server.close()]);
  }
});

test("brain_search forwards atDate to the retrieval engine", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const common = {
    tenantId: "tenant-a", projectId: "allowed-project", domainId: 2, type: "business_rule",
    status: "approved", sourceId: "test", sourceOrigin: "internal", sourceKind: "git", sourceUri: ".brain/rule.yaml",
    version: 1, confidence: 1, trustLevel: "verified", isInferred: false, tags: [], relatedIds: [],
    accessPolicyId: "internal-project", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  runtime.retrieval.upsertItem({ ...common, id: "RULE-PAST", title: "Regra historica de cobranca", content: "Cobranca antiga.", contentHash: "past", validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2026-06-01T00:00:00.000Z" });
  runtime.retrieval.upsertItem({ ...common, id: "RULE-CURRENT", title: "Regra vigente de cobranca", content: "Cobranca atual.", contentHash: "current", validFrom: "2026-06-01T00:00:00.000Z", validUntil: undefined });
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({
      name: "brain_search",
      arguments: { projectId: "allowed-project", query: "cobranca", atDate: "2026-03-15T00:00:00.000Z" }
    });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(payload.items.map((item) => item.id), ["RULE-PAST"]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_change_propose persists the proposal through the SQL knowledge repository", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const persisted = [];
  runtime.retrieval.upsertItem = undefined;
  runtime.knowledge = {
    async listVersions() { return []; },
    async upsertItem(rlsContext, item) {
      persisted.push({ rlsContext, item });
      return { item, versionCreated: true };
    }
  };
  const { client, server } = await openMcp(runtime);
  try {
    const response = await client.callTool({
      name: "brain_change_propose",
      arguments: { projectId: "allowed-project", title: "New retry rule", content: "Retries must be bounded." }
    });
    assert.notEqual(response.isError, true);
    const proposal = JSON.parse(response.content[0].text);
    assert.equal(persisted.length, 1, "proposal knowledge is persisted before the MCP tool reports success");
    assert.equal(persisted[0].rlsContext.tenantId, "tenant-a");
    assert.deepEqual(persisted[0].rlsContext.allowedProjects, ["allowed-project"]);
    assert.deepEqual(persisted[0].rlsContext.allowedPolicies, ["public-org", "internal-project"]);
    assert.equal(persisted[0].item.id, proposal.proposalId);
    assert.equal(persisted[0].item.status, "draft");
    assert.equal(persisted[0].item.title, "New retry rule");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("MCP rejects invalid resume selectors, empty validations, and empty impact inputs", async () => {
  const { client, server } = await openMcp(createNoemaRuntime(new InMemoryAuditLogger()));
  try {
    const cases = [
      { name: "brain_resume_handoff", arguments: { projectId: "allowed-project" } },
      { name: "brain_resume_handoff", arguments: { projectId: "allowed-project", handoffId: "h1", taskId: "t1" } },
      { name: "brain_validate_implementation", arguments: { projectId: "allowed-project" } },
      { name: "brain_analyze_change_impact", arguments: { projectId: "allowed-project", targetIds: [] } }
    ];
    for (const input of cases) {
      const result = await client.callTool(input);
      assert.equal(result.isError, true, `${input.name} should reject invalid or unsupported arguments`);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_knowledge_get returns the requested persisted item version", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const latest = {
    id: "RULE-VERSIONED", tenantId: "tenant-a", projectId: "allowed-project", domainId: 2, type: "business_rule",
    title: "Current title", content: "Current rule", status: "approved", sourceId: "test", sourceOrigin: "internal",
    sourceKind: "git", sourceVersion: "commit-2", sourceUri: ".brain/rule.md", version: 2, contentHash: "hash-2",
    confidence: 1, trustLevel: "verified", isInferred: false, tags: [], relatedIds: [], accessPolicyId: "internal-project",
    createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", metadata: {}
  };
  runtime.retrieval.upsertItem(latest);
  runtime.knowledge = {
    async listVersions(_ctx, _projectId, itemId) {
      assert.equal(itemId, latest.id);
      return [
        { tenantId: "tenant-a", projectId: "allowed-project", itemId: latest.id, version: 1, domainId: 2, type: "business_rule", title: "Prior title", status: "approved", sourceOrigin: "internal", sourceKind: "git", sourceVersion: "commit-1", contentHash: "hash-1", confidence: 1, trustLevel: "verified", isInferred: false, tags: [], accessPolicyId: "internal-project", content: "Prior rule", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z" },
        { tenantId: "tenant-a", projectId: "allowed-project", itemId: latest.id, version: 2, domainId: 2, type: "business_rule", title: "Current title", status: "approved", sourceOrigin: "internal", sourceKind: "git", sourceVersion: "commit-2", contentHash: "hash-2", confidence: 1, trustLevel: "verified", isInferred: false, tags: [], accessPolicyId: "internal-project", content: "Current rule", metadata: {}, createdAt: "2026-02-01T00:00:00.000Z" }
      ];
    }
  };
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({ name: "brain_knowledge_get", arguments: { projectId: "allowed-project", id: latest.id, version: 1 } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.item.version, 1);
    assert.equal(payload.item.title, "Prior title");
    assert.equal(payload.item.content, "Prior rule");
    assert.equal(payload.requestedVersion, undefined);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_analyze_change_impact reports traversal depth and critical rule risk", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  runtime.retrieval.upsertItem({
    id: "RULE-CRITICAL", tenantId: "tenant-a", projectId: "allowed-project", domainId: 2, type: "business_rule",
    title: "Critical payment invariant", content: "Payment must be idempotent.", status: "approved", sourceId: "test",
    sourceOrigin: "internal", sourceKind: "git", sourceVersion: "commit-a", sourceUri: ".brain/rule.md", version: 1,
    contentHash: "critical-hash", confidence: 1, trustLevel: "verified", isInferred: false, tags: [], relatedIds: [],
    accessPolicyId: "internal-project", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { priority: "critical" }
  });
  runtime.graph.addEdge({
    tenantId: "tenant-a", fromProjectId: "allowed-project", toProjectId: "allowed-project", fromItemId: "PAYMENT-SERVICE",
    toItemId: "RULE-CRITICAL", fromPolicyId: "internal-project", toPolicyId: "internal-project", relationType: "GOVERNED_BY",
    isInferred: false, confidence: 1
  });
  runtime.crossServiceRegistry.registerContract({
    tenantId: "tenant-a", fromProjectId: "allowed-project", fromService: "PAYMENT-SERVICE", relation: "PUBLISHES_EVENT",
    toProjectId: "allowed-project", contractId: "PAYMENT-EVENT", schemaVersion: "1.0.0", accessPolicyId: "internal-project"
  });
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({ name: "brain_analyze_change_impact", arguments: { projectId: "allowed-project", targetIds: ["PAYMENT-SERVICE"] } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.riskLevel, "critical");
    assert.equal(payload.directImpacts.length, 1);
    assert.equal(payload.criticalRulesImpacted[0].id, "RULE-CRITICAL");
    assert.equal(payload.crossServiceImpacts[0].contractId, "PAYMENT-EVENT");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_find_related_code classifies authorized graph items as symbols, files, and tests", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const now = "2026-01-01T00:00:00.000Z";
  const relatedItems = [
    { id: "SYM-1", type: "code_symbol", sourceUri: "packages/payments/src/refund.ts" },
    { id: "FILE-1", type: "document", sourceUri: "packages/payments/src/refund.ts" },
    { id: "TEST-1", type: "test", sourceUri: "packages/payments/test/refund.test.ts" }
  ];
  for (const item of relatedItems) {
    runtime.retrieval.upsertItem({
      ...item, tenantId: "tenant-a", projectId: "allowed-project", domainId: 3, title: item.id, content: "",
      status: "approved", sourceId: "test", sourceOrigin: "internal", sourceKind: "git", sourceVersion: "commit-a",
      version: 1, contentHash: item.id, confidence: 1, trustLevel: "verified", isInferred: false, tags: [], relatedIds: [],
      accessPolicyId: "internal-project", createdAt: now, updatedAt: now
    });
    runtime.graph.addEdge({
      tenantId: "tenant-a", fromProjectId: "allowed-project", toProjectId: "allowed-project", fromItemId: "REQ-1",
      toItemId: item.id, fromPolicyId: "internal-project", toPolicyId: "internal-project", relationType: "IMPLEMENTS",
      isInferred: false, confidence: 1
    });
  }
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({ name: "brain_find_related_code", arguments: { projectId: "allowed-project", targetId: "REQ-1" } });
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(payload.symbols.map((hit) => hit.item.id), ["SYM-1"]);
    assert.deepEqual(payload.files.map((hit) => hit.item.id), ["FILE-1"]);
    assert.deepEqual(payload.tests.map((hit) => hit.item.id), ["TEST-1"]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_resume_handoff selects a persisted handoff by ID and reports active database leases", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const handoff = {
    handoffId: "HO-EXACT", tenantId: "tenant-a", projectId: "allowed-project", taskId: "TASK-EXACT",
    fromAgent: "agent-old", repoUrl: "repo", branch: "feature/payments", baseCommitSha: "abc123",
    modifiedFiles: [], testsExecuted: [], decisions: [], nextSteps: ["Review"], workingTreeDirty: false,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  runtime.opRepo = {
    async getHandoffById(_ctx, _projectId, handoffId) { return handoffId === handoff.handoffId ? handoff : undefined; },
    async getLatestHandoff() { throw new Error("handoffId lookup must not fall back to latest"); },
    async getTaskLease() { return { actorId: "agent-current", branch: "feature/payments" }; }
  };
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({ name: "brain_resume_handoff", arguments: { projectId: "allowed-project", handoffId: "HO-EXACT", currentCommitSha: "def456" } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.handoff.handoffId, "HO-EXACT");
    assert.ok(payload.warnings.some((warning) => /Task Lease ativo por 'agent-current'/.test(warning)));
    assert.ok(payload.warnings.some((warning) => /Divergência de commit/.test(warning)));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_delegate_task creates a recurring schedule when cron is supplied", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  let scheduled;
  runtime.scheduleRunnerTask = async (input) => {
    scheduled = input;
    return { scheduleId: "schedule-1" };
  };
  const { client, server } = await openMcp(runtime);
  try {
    const result = await client.callTool({
      name: "brain_delegate_task",
      arguments: { projectId: "allowed-project", instruction: "Review open PRs", cron: "0 9 * * 1", priority: "high" }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(scheduled, {
      tenantId: "tenant-a", projectId: "allowed-project", actorId: "agent-a", accessPolicyId: "internal-project",
      instruction: "Review open PRs", cron: "0 9 * * 1", priority: "high"
    });
    assert.deepEqual(payload, { scheduleId: "schedule-1", status: "scheduled", cron: "0 9 * * 1" });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("brain_change_decide blocks agent self-approval and lets authorized human approve draft", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const agentMcp = await openMcp(runtime);
  const humanCtx = {
    tenantId: "tenant-a",
    actorId: "human-1",
    actorType: "human",
    roles: ["tech-lead"],
    allowedProjects: ["allowed-project"],
    allowedPolicies: ["public-org", "internal-project"]
  };
  const humanMcp = await openMcp(runtime, humanCtx);
  try {
    const proposeRes = await agentMcp.client.callTool({
      name: "brain_change_propose",
      arguments: { projectId: "allowed-project", title: "Onboarding guide", content: "Monorepo map." }
    });
    assert.notEqual(proposeRes.isError, true);
    const { proposalId } = JSON.parse(proposeRes.content[0].text);

    const deniedRes = await agentMcp.client.callTool({
      name: "brain_change_decide",
      arguments: { projectId: "allowed-project", proposalId, decision: "approve" }
    });
    assert.equal(deniedRes.isError, true);

    const decideRes = await humanMcp.client.callTool({
      name: "brain_change_decide",
      arguments: { projectId: "allowed-project", proposalId, decision: "approve", note: "Revisado via MCP" }
    });
    assert.notEqual(decideRes.isError, true);
    const decided = JSON.parse(decideRes.content[0].text);
    assert.equal(decided.proposalId, proposalId);
    assert.equal(decided.status, "approved");
    assert.equal(decided.itemStatus, "approved");
    assert.equal(decided.reviewNote, "Revisado via MCP");

    const storedRes = await humanMcp.client.callTool({
      name: "brain_knowledge_get",
      arguments: { projectId: "allowed-project", id: proposalId }
    });
    assert.notEqual(storedRes.isError, true);
    const stored = JSON.parse(storedRes.content[0].text);
    assert.equal(stored.item?.status, "approved");
  } finally {
    await Promise.all([agentMcp.client.close(), agentMcp.server.close(), humanMcp.client.close(), humanMcp.server.close()]);
  }
});

test("brain_bootstrap_project registers a new project when createIfMissing or name is provided", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const { client, server } = await openMcp(runtime);
  try {
    const createRes = await client.callTool({
      name: "brain_bootstrap_project",
      arguments: {
        projectId: "allowed-project",
        createIfMissing: true,
        name: "Allowed Billing API",
        description: "Core billing service",
        knowledgeRoot: ".brain/"
      }
    });
    assert.notEqual(createRes.isError, true);
    const created = JSON.parse(createRes.content[0].text);
    assert.equal(created.created, true);
    assert.equal(created.project?.name, "Allowed Billing API");
    assert.equal(created.project?.description, "Core billing service");

    const secondRes = await client.callTool({
      name: "brain_bootstrap_project",
      arguments: { projectId: "allowed-project" }
    });
    assert.notEqual(secondRes.isError, true);
    const second = JSON.parse(secondRes.content[0].text);
    assert.equal(second.created, false);
    assert.equal(second.project?.name, "Allowed Billing API");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("extended MCP tools support ingestion, task planning, health, file leases, proposals, and incident mapping", async () => {
  const runtime = createNoemaRuntime(new InMemoryAuditLogger());
  const { client, server } = await openMcp(runtime);
  try {
    const ingestRes = await client.callTool({
      name: "brain_ingest_knowledge",
      arguments: {
        projectId: "allowed-project",
        filePath: ".brain/01-business/business-rules/BR-RETRY.md",
        content: "---\nid: BR-RETRY\ntitle: Retry Limit\ntype: business_rule\ndomainId: 2\nstatus: approved\n---\nMax 3 retries."
      }
    });
    assert.notEqual(ingestRes.isError, true);

    const planRes = await client.callTool({
      name: "brain_plan_tasks",
      arguments: { projectId: "allowed-project", epicDescription: "Implement bounded retries" }
    });
    assert.notEqual(planRes.isError, true);
    const plan = JSON.parse(planRes.content[0].text);
    assert.ok(plan.count >= 1);

    const healthRes = await client.callTool({
      name: "brain_knowledge_health",
      arguments: { projectId: "allowed-project" }
    });
    assert.notEqual(healthRes.isError, true);

    const leaseRes = await client.callTool({
      name: "brain_acquire_lease",
      arguments: { projectId: "allowed-project", taskId: "T-1", branch: "feat/retry", targetFiles: ["src/retry.ts"] }
    });
    assert.notEqual(leaseRes.isError, true);

    const checkLeaseRes = await client.callTool({
      name: "brain_check_file_leases",
      arguments: { projectId: "allowed-project", targetFiles: ["src/retry.ts"] }
    });
    assert.notEqual(checkLeaseRes.isError, true);

    const listPropRes = await client.callTool({
      name: "brain_list_proposals",
      arguments: { projectId: "allowed-project" }
    });
    assert.notEqual(listPropRes.isError, true);

    const incidentRes = await client.callTool({
      name: "brain_incident_to_code",
      arguments: { projectId: "allowed-project", incidentId: "INC-1", title: "Retry timeout", service: "allowed-project" }
    });
    assert.notEqual(incidentRes.isError, true);

    const fbRes = await client.callTool({
      name: "brain_context_feedback",
      arguments: { projectId: "allowed-project", sessionId: "sess-1", usefulItemIds: ["BR-RETRY"] }
    });
    assert.notEqual(fbRes.isError, true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
