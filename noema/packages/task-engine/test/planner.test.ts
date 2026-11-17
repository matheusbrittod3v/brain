import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@noema/core";
import { planAutonomousTasks } from "../src/index.js";

function makeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const now = "2026-10-01T00:00:00Z";
  return {
    id: "BR-1",
    tenantId: "t1",
    projectId: "p1",
    domainId: 1,
    type: "business_rule",
    title: "Regra Base",
    content: "Conteúdo da regra",
    status: "approved",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "v1",
    sourceUri: "src/billing.ts",
    version: 1,
    contentHash: "h1",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("task-engine", () => {
  it("plans epic, stories, and priority-ordered tasks with dependencies and acceptance criteria", () => {
    const req = makeItem({
      id: "REQ-1",
      type: "requirement",
      title: "Checkout com Pix",
      content: "Permitir pagamento instantâneo",
      relatedIds: ["BR-CRIT"],
      metadata: { priority: "high", acceptanceCriteria: ["Gerar QR Code válido"] }
    });

    const lowRule = makeItem({
      id: "BR-LOW",
      title: "Log de auditoria",
      metadata: { priority: "low" }
    });

    const critRule = makeItem({
      id: "BR-CRIT",
      title: "Idempotência de pagamento",
      metadata: { severity: "critical", acceptanceCriteria: ["Chave idempotente obrigatória"] }
    });

    const plan = planAutonomousTasks("Novo Checkout Pix", [lowRule, critRule], {
      requirements: [req],
      impactedRuleIds: ["BR-LOW", "BR-CRIT"],
      uncoveredRuleIds: ["BR-CRIT"]
    });

    assert.equal(plan[0]?.kind, "epic");
    assert.equal(plan[0]?.priority, "critical");

    const story = plan.find((t) => t.kind === "story");
    assert.ok(story);
    assert.deepEqual(story.dependencies, ["EPIC-1"]);
    assert.deepEqual(story.acceptanceCriteria, ["Gerar QR Code válido"]);

    const implTasks = plan.filter((t) => t.id.startsWith("TASK-IMPL-"));
    assert.equal(implTasks.length, 2);
    assert.equal(implTasks[0]?.relatedRuleIds[0], "BR-CRIT");
    assert.equal(implTasks[1]?.relatedRuleIds[0], "BR-LOW");

    const testTask = plan.find((t) => t.id.startsWith("TASK-TEST-"));
    assert.ok(testTask);
    assert.deepEqual(testTask.relatedRuleIds, ["BR-CRIT"]);
    assert.deepEqual(testTask.dependencies, [implTasks[0]!.id]);
  });
});
