import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@brain/core";
import type { GraphEdge } from "@brain/graph";
import {
  buildBusinessTraceabilityMatrix,
  buildTraceabilityReport
} from "../src/index.js";

function makeItem(
  id: string,
  type: KnowledgeItem["type"],
  overrides: Partial<KnowledgeItem> = {}
): KnowledgeItem {
  return {
    id,
    tenantId: "t1",
    projectId: "p1",
    domainId: 1,
    type,
    title: id,
    content: id,
    status: "approved",
    sourceId: "src",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "1",
    sourceUri: `${id}.ts`,
    version: 1,
    contentHash: "h",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function makeEdge(
  fromItemId: string,
  toItemId: string,
  relationType: GraphEdge["relationType"]
): GraphEdge {
  return {
    tenantId: "t1",
    fromProjectId: "p1",
    toProjectId: "p1",
    fromItemId,
    toItemId,
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType,
    isInferred: false,
    confidence: 1
  };
}

describe("business-traceability", () => {
  it("builds Rule -> Requirement -> CodeSymbol -> Test matrix and flags uncovered rules", () => {
    const items: KnowledgeItem[] = [
      makeItem("rule-1", "business_rule", { metadata: { priority: "critical" } }),
      makeItem("req-1", "requirement"),
      makeItem("sym-1", "code_symbol"),
      makeItem("test-1", "test"),
      makeItem("rule-2", "business_rule", { metadata: { priority: "high" } })
    ];

    const edges: GraphEdge[] = [
      makeEdge("req-1", "rule-1", "GOVERNED_BY"),
      makeEdge("sym-1", "req-1", "IMPLEMENTS"),
      makeEdge("sym-1", "test-1", "VERIFIED_BY")
    ];

    const matrix = buildBusinessTraceabilityMatrix(items, edges);
    assert.equal(matrix.length, 2);

    const r1 = matrix.find((m) => m.ruleId === "rule-1")!;
    assert.deepEqual(r1.requirements, ["req-1"]);
    assert.deepEqual(r1.codeSymbols, ["sym-1"]);
    assert.deepEqual(r1.tests, ["test-1"]);
    assert.equal(r1.uncovered, false);
    assert.equal(r1.uncoveredCritical, false);
    assert.deepEqual(r1.gaps, []);

    const r2 = matrix.find((m) => m.ruleId === "rule-2")!;
    assert.equal(r2.uncovered, true);
    assert.equal(r2.uncoveredCritical, true);
    assert.deepEqual(r2.gaps, ["NO_REQUIREMENT", "NO_CODE_SYMBOL", "NO_TEST"]);

    const report = buildTraceabilityReport(items, edges);
    assert.equal(report.totalRules, 2);
    assert.equal(report.coveredRules, 1);
    assert.equal(report.uncoveredRules.length, 1);
    assert.equal(report.uncoveredCriticalRules.length, 1);
    assert.equal(report.coverageRatio, 0.5);
  });
});
