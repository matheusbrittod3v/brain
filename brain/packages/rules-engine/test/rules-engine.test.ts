import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@brain/core";
import {
  evaluateBusinessRule,
  evaluateBusinessRules,
  evaluateRulePreconditions,
  extractStructuredRule
} from "../src/index.js";

function makeRuleItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "rule-1",
    tenantId: "t1",
    projectId: "p1",
    domainId: 1,
    type: "business_rule",
    title: "Require KYC before payout",
    content: "Payouts require KYC verification.",
    status: "approved",
    sourceId: "src-1",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "1",
    sourceUri: "rules/kyc.md",
    version: 1,
    contentHash: "hash",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    metadata: {
      priority: "critical",
      conditions: ["kyc_verified", "account_active"],
      effects: ["allow_payout", "emit_audit_event"],
      exceptions: ["manual_compliance_override"]
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("rules-engine", () => {
  it("extracts structured rules and evaluates preconditions", () => {
    const rule = extractStructuredRule(makeRuleItem());
    assert.equal(rule.priority, "critical");
    assert.deepEqual(rule.conditions, ["kyc_verified", "account_active"]);

    const pre = evaluateRulePreconditions(rule, new Set(["kyc_verified"]));
    assert.equal(pre.allowed, false);
    assert.deepEqual(pre.missingConditions, ["account_active"]);
  });

  it("returns structured compliance and violation reasons for conditions, effects, and exceptions", () => {
    const item = makeRuleItem();

    const compliant = evaluateBusinessRule(item, {
      satisfiedConditions: ["kyc_verified", "account_active"],
      observedEffects: ["allow_payout", "emit_audit_event"]
    });
    assert.equal(compliant.status, "compliant");
    assert.equal(compliant.compliant, true);
    assert.equal(compliant.allowed, true);
    assert.equal(compliant.reasons.filter((r) => r.code === "CONDITION_MET").length, 2);
    assert.equal(compliant.reasons.filter((r) => r.code === "EFFECT_APPLIED").length, 2);

    const violatedEffect = evaluateBusinessRule(item, {
      satisfiedConditions: ["kyc_verified", "account_active"],
      observedEffects: ["allow_payout"]
    });
    assert.equal(violatedEffect.status, "violated");
    assert.equal(violatedEffect.compliant, false);
    assert.deepEqual(violatedEffect.missingEffects, ["emit_audit_event"]);
    assert.ok(violatedEffect.reasons.some((r) => r.code === "EFFECT_MISSING"));

    const exempted = evaluateBusinessRule(item, {
      satisfiedConditions: ["kyc_verified"],
      activeExceptions: ["manual_compliance_override"]
    });
    assert.equal(exempted.status, "exempted");
    assert.equal(exempted.compliant, true);
    assert.equal(exempted.allowed, false);
    assert.deepEqual(exempted.triggeredExceptions, ["manual_compliance_override"]);
  });

  it("evaluates batches and skips inactive rules unless requested", () => {
    const active = makeRuleItem({ id: "rule-active" });
    const draft = makeRuleItem({ id: "rule-draft", status: "draft" });

    const batch = evaluateBusinessRules([active, draft], {
      satisfiedConditions: ["kyc_verified"]
    });
    assert.equal(batch.violatedCount, 1);
    assert.equal(batch.inactiveCount, 1);
    assert.equal(batch.violations[0]?.ruleId, "rule-active");
  });
});
