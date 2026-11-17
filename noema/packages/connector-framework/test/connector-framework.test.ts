import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@noema/core";
import { buildConnectorRelationsAndConflicts } from "../src/index.js";

function makeItem(overrides: Partial<KnowledgeItem>): KnowledgeItem {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "ITEM-1",
    tenantId: "acme",
    projectId: "sub",
    domainId: 6,
    type: "task",
    title: "Default title",
    content: "Default content",
    status: "draft",
    sourceId: "src-1",
    sourceOrigin: "internal",
    sourceKind: "connector",
    sourceVersion: "v1",
    sourceUri: "https://example.com/1",
    version: 1,
    contentHash: "hash-1",
    confidence: 0.9,
    trustLevel: "untrusted",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("emits IMPLEMENTS edge and high conflict when external task collides with approved Git-authoritative rule", () => {
  const gitRule = makeItem({
    id: "BR-SUB-001",
    domainId: 1,
    type: "business_rule",
    title: "Validar chargeback antes do cancelamento",
    status: "approved",
    sourceKind: "git",
    trustLevel: "verified"
  });

  const jiraTask = makeItem({
    id: "JIRA-482",
    domainId: 6,
    type: "task",
    title: "Implementar BR-SUB-001",
    content: "Implementação da regra BR-SUB-001 no serviço de assinatura",
    sourceKind: "connector"
  });

  const result = buildConnectorRelationsAndConflicts(jiraTask, [gitRule]);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]?.type, "IMPLEMENTS");
  assert.equal(result.edges[0]?.toId, "BR-SUB-001");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.severity, "high");
  assert.equal(result.conflicts[0]?.domainId, 1);
});

test("emits RELATED_TO edge without Git conflict for non-Git-authoritative domain", () => {
  const existingTask = makeItem({
    id: "LINEAR-10",
    domainId: 6,
    type: "document",
    title: "Notas de sprint",
    sourceKind: "connector"
  });

  const slackNote = makeItem({
    id: "SLACK-99",
    domainId: 6,
    type: "document",
    title: "Notas de sprint",
    sourceKind: "connector"
  });

  const result = buildConnectorRelationsAndConflicts(slackNote, [existingTask]);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0]?.type, "RELATED_TO");
  assert.equal(result.conflicts.length, 0);
});
