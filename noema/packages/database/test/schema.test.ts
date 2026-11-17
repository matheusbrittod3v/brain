import test from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "@noema/auth";
import { approvalRequests, gitIngestionHeads, integrationEvents, knowledgeItems, knowledgeItemVersions, notificationOutbox, notificationPreferences, projectRepositoryHeads, runnerTaskQuestions, testExecutionResults } from "../src/schema.js";
import { withTenantRls, type NoemaDb } from "../src/client.js";
import { PgAuditLogger } from "../src/repositories.js";
import { contextSessionItems } from "../src/schema.js";
import { validateContextSessionId } from "@noema/core";

test("exports schema tables with multi-tenant and versioning keys", () => {
  assert.ok(knowledgeItems.tenantId);
  assert.ok(knowledgeItems.accessPolicyId);
  assert.ok(knowledgeItems.hitCount);
  assert.ok(knowledgeItems.contextSentCount);
  assert.ok(knowledgeItems.contextHitCount);
  assert.ok(contextSessionItems.sessionId);
  assert.ok(contextSessionItems.hitEvidence);
  assert.ok(knowledgeItemVersions.accessPolicyId);
  assert.ok(knowledgeItemVersions.version);
  assert.ok(approvalRequests.id);
  assert.ok(approvalRequests.tenantId);
  assert.ok(approvalRequests.projectId);
  assert.ok(approvalRequests.accessPolicyId);
  assert.ok(approvalRequests.status);
  assert.ok(approvalRequests.assignedTo);
  assert.ok(notificationPreferences.actorId);
  assert.ok(notificationPreferences.channels);
  assert.ok(notificationPreferences.categories);
  assert.ok(notificationOutbox.eventKey);
  assert.ok(notificationOutbox.scheduledAt);
  assert.ok(integrationEvents.externalEventId);
  assert.ok(integrationEvents.eventHash);
  assert.ok(integrationEvents.response);
  assert.ok(runnerTaskQuestions.questionId);
  assert.ok(runnerTaskQuestions.responseIdempotencyKey);
  assert.ok(testExecutionResults.runId);
  assert.ok(testExecutionResults.testItemId);
  assert.ok(testExecutionResults.status);
  assert.ok(testExecutionResults.commitSha);
  assert.ok(testExecutionResults.repository);
  assert.ok(projectRepositoryHeads.repository);
  assert.ok(projectRepositoryHeads.branch);
  assert.ok(projectRepositoryHeads.commitSha);
  assert.ok(gitIngestionHeads.repository);
  assert.ok(gitIngestionHeads.branch);
  assert.ok(gitIngestionHeads.commitSha);
  assert.ok(runnerTaskQuestions.status);
});

test("validates opaque Context Session IDs without accepting empty, control, or oversized values", () => {
  assert.equal(validateContextSessionId("  chat-1  "), "chat-1");
  assert.throws(() => validateContextSessionId("   "), /1–128/);
  assert.throws(() => validateContextSessionId("session\nforged"), /1–128/);
  assert.throws(() => validateContextSessionId("s".repeat(129)), /1–128/);
});

test("withTenantRls sets tenant, allowed_projects, and allowed_policies and fails closed on empty allowedProjects", async () => {
  const executedParams: unknown[] = [];
  const fakeDb = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async execute(query: { queryChunks?: unknown[] }) {
          executedParams.push(query);
          return [];
        }
      };
      return fn(tx);
    }
  } as unknown as NoemaDb;

  const validCtx: AuthContext = {
    tenantId: "tenant-1",
    actorId: "user-1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["internal-project"]
  };

  const result = await withTenantRls(fakeDb, validCtx, async () => "ok");
  assert.equal(result, "ok");
  assert.equal(executedParams.length, 1);

  await assert.rejects(
    withTenantRls(
      fakeDb,
      { ...validCtx, allowedProjects: [] },
      async () => "should-not-run"
    ),
    /allowedProjects must be a non-empty array/
  );
});

test("PgAuditLogger.record enforces RLS session context and rejects missing accessPolicyId", async () => {
  const inserts: unknown[] = [];
  const executed: unknown[] = [];
  const fakeDb = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async execute(query: unknown) {
          executed.push(query);
          return [];
        },
        insert() {
          return {
            async values(v: unknown) {
              inserts.push(v);
              return [];
            }
          };
        }
      };
      return fn(tx);
    }
  } as unknown as NoemaDb;

  const logger = new PgAuditLogger(fakeDb);
  await logger.record({
    tenantId: "tenant-1",
    projectId: "proj-1",
    accessPolicyId: "restricted-security",
    actorId: "actor-1",
    actorType: "human",
    action: "knowledge.read",
    targetType: "knowledge_item",
    targetId: "KI-1"
  });

  assert.equal(executed.length, 1);
  assert.equal(inserts.length, 1);
  assert.equal((inserts[0] as { accessPolicyId: string }).accessPolicyId, "restricted-security");

  await assert.rejects(
    logger.record({
      tenantId: "tenant-1",
      projectId: "proj-1",
      accessPolicyId: "",
      actorId: "actor-1",
      actorType: "human",
      action: "knowledge.read",
      targetType: "knowledge_item"
    }),
    /accessPolicyId is required/
  );
});

