import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@noema/core";
import { evaluateBusinessRuleCompliance } from "../src/index.js";

function makeRule(id: string, status: KnowledgeItem["status"] = "approved"): KnowledgeItem {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "acme",
    projectId: "sub",
    domainId: 2,
    type: "business_rule",
    title: `Rule ${id}`,
    content: "Regra",
    status,
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "v1",
    sourceUri: `.brain/${id}.yaml`,
    version: 1,
    contentHash: "h1",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    createdAt: now,
    updatedAt: now
  };
}

test("BusinessRuleGuardian detects missing VERIFIED_BY in enforced mode", () => {
  const report = evaluateBusinessRuleCompliance({
    mode: "enforced",
    files: [{ path: "src/cancel.ts", content: "// @brain-rule BR-SUB-014\nexport function cancel() {}" }],
    activeRules: [makeRule("BR-SUB-014")],
    verifiedRuleIds: new Set()
  });
  assert.equal(report.passed, false);
  assert.equal(report.violations.length, 1);
});

test("detects deprecated rule references and missing/failing test files across audit, advisory, enforced", () => {
  const files = [
    { path: "src/old.ts", content: "// @brain-rule BR-OLD\nexport function oldFn() {}" },
    { path: "src/billing.ts", content: "// @brain-rule BR-BILL-1\nexport function bill() {}" }
  ];
  const activeRules = [makeRule("BR-OLD", "deprecated"), makeRule("BR-BILL-1", "approved")];

  const baseOpts = {
    files,
    activeRules,
    verifiedRuleIds: new Set(["BR-BILL-1"]),
    ruleTestFiles: { "BR-BILL-1": ["test/billing.test.ts"] },
    existingTestFiles: ["test/other.test.ts"],
    testExecutionResults: { "test/billing.test.ts": "failed" as const }
  };

  const enforced = evaluateBusinessRuleCompliance({ mode: "enforced", ...baseOpts });
  assert.equal(enforced.passed, false);
  assert.equal(enforced.violations.length, 3);

  const advisory = evaluateBusinessRuleCompliance({ mode: "advisory", ...baseOpts });
  assert.equal(advisory.passed, true);
  assert.equal(advisory.violations.length, 3);

  const audit = evaluateBusinessRuleCompliance({ mode: "audit", ...baseOpts });
  assert.equal(audit.passed, true);
  assert.equal(audit.violations.length, 3);
});

test("passes enforced mode when rule is approved, verified, test file exists and passed", () => {
  const report = evaluateBusinessRuleCompliance({
    mode: "enforced",
    files: [{ path: "src/billing.ts", content: "// @brain-rule BR-BILL-1\nexport function bill() {}" }],
    activeRules: [makeRule("BR-BILL-1", "approved")],
    verifiedRuleIds: new Set(["BR-BILL-1"]),
    ruleTestFiles: { "BR-BILL-1": ["test/billing.test.ts"] },
    existingTestFiles: ["test/billing.test.ts"],
    testExecutionResults: { "test/billing.test.ts": "passed" }
  });
  assert.equal(report.passed, true);
  assert.equal(report.violations.length, 0);
});
