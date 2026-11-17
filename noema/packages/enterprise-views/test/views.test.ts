import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBusinessRuleTestCoverageMatrix,
  buildIncidentToCodeMap,
  buildProjectBlueprint,
  buildTechRadar,
  buildTopologyBlastRadius,
  classifyPiiEndpoints,
  evaluatePreDeployReadiness,
  evaluateSbomCveGuard,
  planAutonomousTasks,
  simulateProjectChange
} from "../src/index.js";

describe("enterprise-views", () => {
  it("computes QA coverage matrix, Tech Radar, SBOM guard, planner and simulator", () => {
    const items = [
      {
        id: "BR-1",
        tenantId: "t1",
        projectId: "p1",
        domainId: 2,
        type: "business_rule" as const,
        title: "Regra 1",
        content: "C1",
        status: "approved" as const,
        sourceId: "git",
        sourceOrigin: "internal" as const,
        sourceKind: "git" as const,
        sourceVersion: "v1",
        sourceUri: ".brain/br-1.md",
        version: 1,
        contentHash: "h1",
        confidence: 1,
        trustLevel: "verified" as const,
        isInferred: false,
        validFrom: "2026-01-01T00:00:00Z",
        tags: ["typescript", "fastify"],
        accessPolicyId: "internal-project",
        relatedIds: [],
        metadata: {},
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }
    ];
    const edges = [
      {
        tenantId: "t1",
        fromProjectId: "p1",
        toProjectId: "p1",
        fromItemId: "test/br1.test.ts",
        toItemId: "BR-1",
        relationType: "VERIFIED_BY" as const,
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        isInferred: false,
        confidence: 1
      }
    ];

    const qa = buildBusinessRuleTestCoverageMatrix(items, edges);
    assert.equal(qa.coveragePercent, 100);
    assert.ok(buildTechRadar(items).some((t) => t.technology === "typescript"));
    assert.equal(evaluateSbomCveGuard([{ name: "lodash", version: "4.17.20", severity: "high" }]).passed, false);
    assert.equal(planAutonomousTasks("Novo checkout", items).length, 3);
    assert.equal(simulateProjectChange(["BR-1"], false).approvedToProceed, true);
  });

  it("counts VERIFIED_BY only when the test exists and its latest CI result passed", () => {
    const rule = {
      id: "BR-CI", tenantId: "t1", projectId: "p1", domainId: 2,
      type: "business_rule" as const, title: "Rule", content: "C1", status: "approved" as const,
      sourceId: "git", sourceOrigin: "internal" as const, sourceKind: "git" as const,
      sourceVersion: "a".repeat(40), sourceUri: "rules/BR-CI.md", version: 1, contentHash: "h",
      confidence: 1, trustLevel: "verified" as const, isInferred: false, tags: [], relatedIds: [],
      accessPolicyId: "internal-project", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
    };
    const test = { ...rule, id: "tests/BR-CI.test.ts", type: "test" as const, title: "CI test", sourceUri: "tests/BR-CI.test.ts" };
    const edges = [{
      tenantId: "t1", fromProjectId: "p1", toProjectId: "p1", fromItemId: test.id, toItemId: rule.id,
      relationType: "VERIFIED_BY" as const, fromPolicyId: "internal-project", toPolicyId: "internal-project",
      isInferred: false, confidence: 1
    }];
    const items = [rule, test];
    const result = { testItemId: test.id, status: "passed" as const, commitSha: "a".repeat(40), repository: "acme/billing" };

    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, { testResults: [result] }).rows[0]?.covered, true);
    assert.equal(buildBusinessRuleTestCoverageMatrix([rule], edges, {
      testResults: [result],
      testItemsById: new Map([[test.id, test]])
    }).rows[0]?.covered, true);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, { testResults: [{ ...result, status: "failed" }] }).rows[0]?.covered, false);
    assert.equal(buildBusinessRuleTestCoverageMatrix([rule], edges, { testResults: [result] }).rows[0]?.covered, false);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, { testResults: [{ ...result, commitSha: "b".repeat(40) }] }).rows[0]?.covered, false);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, {
      testResults: [result], requireMainHead: true, mainHeadByRepository: new Map()
    }).rows[0]?.covered, false);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, {
      testResults: [result], requireMainHead: true, mainHeadByRepository: new Map([["acme/billing", "a".repeat(40)]])
    }).rows[0]?.covered, true);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, {
      testResults: [result], requireMainHead: true, mainHeadByRepository: new Map([["acme/billing", "b".repeat(40)]])
    }).rows[0]?.covered, false);
    assert.equal(buildBusinessRuleTestCoverageMatrix(items, edges, {
      testResults: [result], requireMainHead: true, requireRepositoryAssociation: true,
      mainHeadByRepository: new Map([["acme/billing", "a".repeat(40)]])
    }).rows[0]?.covered, false);
    const associatedTest = { ...test, metadata: { sourceRepository: "acme/billing" } };
    assert.equal(buildBusinessRuleTestCoverageMatrix([rule, associatedTest], edges, {
      testResults: [result], requireMainHead: true, requireRepositoryAssociation: true,
      mainHeadByRepository: new Map([["acme/billing", "a".repeat(40)]])
    }).rows[0]?.covered, true);
    const mismatchedTest = { ...test, metadata: { sourceRepository: "acme/identity" } };
    assert.equal(buildBusinessRuleTestCoverageMatrix([rule, mismatchedTest], edges, {
      testResults: [result], requireMainHead: true, requireRepositoryAssociation: true,
      mainHeadByRepository: new Map([["acme/billing", "a".repeat(40)]])
    }).rows[0]?.covered, false);
  });

  it("builds topology blast radius, incident-to-code map, and pre-deploy readiness", () => {
    const items = [
      {
        id: "svc-auth",
        tenantId: "t1",
        projectId: "auth",
        domainId: 1,
        type: "service" as const,
        title: "Auth Service",
        content: "POST /v1/login",
        status: "approved" as const,
        sourceId: "git",
        sourceOrigin: "internal" as const,
        sourceKind: "git" as const,
        sourceVersion: "v1",
        sourceUri: "services/auth/src/login.ts",
        version: 1,
        contentHash: "h1",
        confidence: 1,
        trustLevel: "verified" as const,
        isInferred: false,
        tags: ["auth", "jwt"],
        accessPolicyId: "internal-project",
        relatedIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      },
      {
        id: "svc-billing",
        tenantId: "t1",
        projectId: "billing",
        domainId: 2,
        type: "service" as const,
        title: "Billing Service",
        content: "Cobrança",
        status: "approved" as const,
        sourceId: "git",
        sourceOrigin: "internal" as const,
        sourceKind: "git" as const,
        sourceVersion: "v1",
        sourceUri: "services/billing/src/index.ts",
        version: 1,
        contentHash: "h2",
        confidence: 1,
        trustLevel: "verified" as const,
        isInferred: false,
        tags: ["billing"],
        accessPolicyId: "internal-project",
        relatedIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }
    ];

    const edges = [
      {
        tenantId: "t1",
        fromProjectId: "billing",
        toProjectId: "auth",
        fromItemId: "svc-billing",
        toItemId: "svc-auth",
        relationType: "DEPENDS_ON" as const,
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        isInferred: false,
        confidence: 1
      }
    ];

    const blast = buildTopologyBlastRadius({ rootNodeId: "svc-auth", edges, items });
    assert.equal(blast.totalImpacted, 1);
    assert.equal(blast.impactedNodes[0]?.itemId, "svc-billing");

    const incidentMap = buildIncidentToCodeMap({
      incidents: [{ id: "INC-42", title: "500 on login", service: "auth", endpoint: "/v1/login" }],
      items,
      edges
    });
    assert.equal(incidentMap.length, 1);
    assert.ok(incidentMap[0]?.candidateFiles.includes("services/auth/src/login.ts"));

    const blocked = evaluatePreDeployReadiness({
      coveragePercent: 70,
      sbomPackages: [{ name: "openssl", version: "1.0.0", severity: "critical" }],
      healthScore: 60,
      openCriticalIncidents: 1,
      guardianPassed: false
    });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.blockers.length, 4);

    const ready = evaluatePreDeployReadiness({
      coveragePercent: 95,
      sbomPackages: [{ name: "zod", version: "3.23.0", severity: "low" }],
      healthScore: 90,
      openCriticalIncidents: 0,
      guardianPassed: true
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.blockers.length, 0);
  });

  it("classifies PII endpoints and builds project blueprint", () => {
    const pii = classifyPiiEndpoints([
      { method: "POST", path: "/v1/customers", fields: ["cpf", "email"], authRequired: false },
      { method: "GET", path: "/health", fields: ["status"], authRequired: false }
    ]);

    assert.equal(pii[0]?.sensitivity, "critical");
    assert.equal(pii[0]?.missingAuthRisk, true);
    assert.ok(pii[0]?.detectedCategories.includes("cpf"));
    assert.equal(pii[1]?.sensitivity, "none");
    assert.equal(pii[1]?.missingAuthRisk, false);

    const blueprint = buildProjectBlueprint({
      name: "Noema Pay",
      domain: "fintech",
      scale: "enterprise",
      compliance: ["LGPD", "PCI-DSS"]
    });
    assert.equal(blueprint.projectName, "Noema Pay");
    assert.ok(blueprint.recommendedAdrs.length >= 3);
    assert.ok(blueprint.recommendedPolicies.some((p) => p.includes("LGPD")));
    assert.ok(blueprint.recommendedPolicies.some((p) => p.includes("PCI-DSS")));
  });
});
