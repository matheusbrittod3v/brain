import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@noema/core";
import type { GraphEdge } from "@noema/graph";
import { computeProjectHealthReport } from "../src/index.js";

function makeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const now = "2026-10-01T00:00:00Z";
  return {
    id: "BR-1",
    tenantId: "t1",
    projectId: "p1",
    domainId: 1,
    type: "business_rule",
    title: "Regra Padrão",
    content: "Conteúdo",
    status: "approved",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "v1",
    sourceUri: ".brain/br-1.md",
    version: 1,
    contentHash: "h1",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: ["billing"],
    relatedIds: [],
    accessPolicyId: "internal-project",
    metadata: { acceptanceCriteria: ["Dado X, então Y"] },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("knowledge-health", () => {
  it("detects uncovered critical rules, missing sourceUri/acceptanceCriteria, contradictions, and precedence conflicts", () => {
    const items: KnowledgeItem[] = [
      makeItem({
        id: "BR-CRIT-1",
        title: "Cobrança Idempotente",
        metadata: { severity: "critical" },
        sourceUri: ""
      }),
      makeItem({
        id: "ADR-1",
        type: "architecture_decision",
        title: "Usar Postgres",
        status: "approved",
        contentHash: "h-adr-1",
        metadata: {}
      }),
      makeItem({
        id: "ADR-2",
        type: "architecture_decision",
        title: "Usar Postgres",
        status: "draft",
        contentHash: "h-adr-2",
        metadata: {}
      }),
      makeItem({
        id: "BR-SYNC",
        sourceKind: "git",
        contentHash: "hash-git"
      }),
      makeItem({
        id: "BR-SYNC",
        sourceKind: "connector",
        sourceOrigin: "external_reference",
        contentHash: "hash-jira"
      })
    ];

    const edges: GraphEdge[] = [
      {
        tenantId: "t1",
        fromProjectId: "p1",
        toProjectId: "p1",
        fromItemId: "test/sync.test.ts",
        toItemId: "BR-SYNC",
        relationType: "VERIFIED_BY",
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        isInferred: false,
        confidence: 1
      }
    ];

    const report = computeProjectHealthReport(items, edges, new Date("2026-10-15T00:00:00Z"), 90);

    assert.deepEqual(report.uncoveredCriticalRuleIds, ["BR-CRIT-1"]);
    assert.ok(report.untestedRuleIds.includes("BR-CRIT-1"));
    assert.deepEqual(report.missingSourceUriIds, ["BR-CRIT-1"]);
    assert.ok(report.missingAcceptanceCriteriaIds.includes("BR-CRIT-1"));
    assert.equal(report.contradictoryItems.length, 1);
    assert.equal(report.gitVsConnectorConflicts.length, 1);
    assert.equal(report.precedenceConflicts[0]?.winningSourceKind, "git");
    assert.ok(report.healthScore < 100);
  });
});
