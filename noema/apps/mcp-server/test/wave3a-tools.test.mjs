import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { createNoemaMcpServer, createNoemaRuntime, createSqlNoemaRuntime } from "../dist/index.js";

const context = {
  tenantId: "tenant-a",
  actorId: "agent-a",
  actorType: "agent",
  roles: ["developer"],
  allowedProjects: ["allowed-project"],
  allowedPolicies: ["public-org", "internal-project"]
};

test("brain_validate_implementation extracts real imports via extractFileDependencies and catches architecture violations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-mcp-arch-"));
  const fileDir = join(dir, "packages", "core", "src");
  mkdirSync(fileDir, { recursive: true });
  const badFile = join(fileDir, "violator.ts");
  writeFileSync(badFile, 'import { createDatabaseClient } from "@noema/database";\nexport const x = createDatabaseClient;\n');

  const runtime = { ...createNoemaRuntime(new InMemoryAuditLogger()), workspaceRoot: dir };
  const server = createNoemaMcpServer(runtime, context, "internal-project");
  const client = new Client({ name: "arch-test", version: "1.0.0" }, { capabilities: {} });
  const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(cTrans), server.connect(sTrans)]);

  try {
    const res = await client.callTool({
      name: "brain_validate_implementation",
      arguments: {
        projectId: "allowed-project",
        diffOrPaths: ["packages/core/src/violator.ts"],
        mode: "enforced"
      }
    });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.passed, false);
    assert.ok(payload.checkedImports >= 1);
    assert.ok(payload.violations.some((v) => v.ruleId === "ARCH-LAYER-VIOLATION"));
  } finally {
    await Promise.all([client.close(), server.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain_create_handoff, brain_delegate_task, brain_record_learning and createSqlNoemaRuntime wire opRepo and PostgresApprovalQueue", async () => {
  const savedHandoffs = [];
  const savedLeases = [];
  const savedTasks = [];
  const savedMemories = [];
  const approvalInserts = [];

  const fakeOpRepo = {
    async saveHandoff(_ctx, ho) { savedHandoffs.push(ho); },
    async upsertLease(_ctx, projectId, taskId, branch) { savedLeases.push({ projectId, taskId, branch }); },
    async getLatestHandoff(_ctx, projectId, taskId) {
      return savedHandoffs.find((h) => h.projectId === projectId && (!taskId || h.taskId === taskId));
    },
    async saveRunnerTask(_ctx, task) { savedTasks.push(task); },
    async appendMemory(_ctx, mem) { savedMemories.push(mem); }
  };

  const fakeAppClient = {
    role: "brain_app",
    async withRlsTransaction(_ctx, callback) {
      const tx = async (strings, ...params) => {
        const sql = strings.join(" ? ");
        if (sql.includes("INSERT INTO approval_requests")) {
          approvalInserts.push(params);
          return [{
            proposal_id: params[0],
            tenant_id: params[1],
            project_id: params[2],
            item_json: params[5],
            requested_by: params[6],
            status: "pending",
            reviewed_by: null,
            review_note: null,
            pr_url: null,
            access_policy_id: params[8],
            created_at: params[9],
            updated_at: params[10]
          }];
        }
        return [];
      };
      return callback(tx);
    },
    async close() {}
  };

  const rlsContext = {
    tenantId: context.tenantId,
    allowedProjects: context.allowedProjects,
    allowedPolicies: context.allowedPolicies
  };
  const runtime = createSqlNoemaRuntime(fakeAppClient, rlsContext, undefined, { opRepo: fakeOpRepo });
  const savedKnowledgeItems = [];
  runtime.knowledge = {
    async listVersions() { return []; },
    async upsertItem(ctx, item) {
      savedKnowledgeItems.push({ ctx, item });
      return { item, versionCreated: true };
    }
  };
  const server = createNoemaMcpServer(runtime, context, "internal-project");
  const client = new Client({ name: "sql-op-test", version: "1.0.0" }, { capabilities: {} });
  const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(cTrans), server.connect(sTrans)]);

  try {
    const hoRes = await client.callTool({
      name: "brain_create_handoff",
      arguments: {
        projectId: "allowed-project",
        taskId: "TASK-42",
        plan: "Finish Wave 3A",
        nextSteps: ["Run tests"],
        workingTreeDirty: true,
        testsExecuted: ["npm test"],
        decisions: ["Use PostgresApprovalQueue"]
      }
    });
    const hoPayload = JSON.parse(hoRes.content[0].text);
    assert.equal(hoPayload.workingTreeDirty, true);
    assert.deepEqual(hoPayload.testsExecuted, ["npm test"]);
    assert.deepEqual(hoPayload.decisions, ["Use PostgresApprovalQueue"]);
    assert.equal(savedHandoffs.length, 1);
    assert.equal(savedLeases.length, 1);

    const taskRes = await client.callTool({
      name: "brain_delegate_task",
      arguments: {
        projectId: "allowed-project",
        instruction: "Sync docs",
        priority: "high"
      }
    });
    const taskPayload = JSON.parse(taskRes.content[0].text);
    assert.equal(taskPayload.status, "queued");
    assert.equal(savedTasks.length, 1);

    const learnRes = await client.callTool({
      name: "brain_record_learning",
      arguments: {
        projectId: "allowed-project",
        summary: "Found missing schema doc",
        missingPaths: ["docs/missing.md"]
      }
    });
    assert.equal(JSON.parse(learnRes.content[0].text).recorded, true);
    assert.equal(savedMemories.length, 1);

    const propRes = await client.callTool({
      name: "brain_change_propose",
      arguments: {
        projectId: "allowed-project",
        targetType: "business_rule",
        title: "New rule",
        content: "Rule body"
      }
    });
    assert.equal(JSON.parse(propRes.content[0].text).status, "draft");
    assert.equal(approvalInserts.length, 1);
    assert.equal(savedKnowledgeItems.length, 1);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
