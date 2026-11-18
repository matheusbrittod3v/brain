import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeDistributedImpact } from "../src/index.js";
import { CrossServiceContractRegistry } from "@brain/cross-service";
import type { AuthContext } from "@brain/auth";
import type { GraphStoreContract, TraversalHit } from "@brain/graph";

const ctx: AuthContext = {
  tenantId: "t1",
  actorId: "u1",
  actorType: "human",
  roles: ["developer"],
  allowedProjects: ["checkout", "billing"],
  allowedPolicies: ["internal-project"]
};

function makeGraph(hitsByItem: Record<string, TraversalHit[]>): GraphStoreContract {
  return {
    addEdge() {},
    traverseRelated(_ctx, start) {
      const itemId = typeof start === "string" ? start : start.itemId;
      return hitsByItem[itemId] ?? [];
    }
  };
}

describe("impact-analysis", () => {
  it("separates direct and transitive impacts and preserves backward-compatible maxDepth", async () => {
    const graph = makeGraph({
      "svc-a": [
        { itemId: "svc-b", projectId: "checkout", hops: 1, via: "DEPENDS_ON", isInferred: false },
        { itemId: "svc-c", projectId: "checkout", hops: 2, via: "IMPACTS", isInferred: false },
        { itemId: "svc-d", projectId: "checkout", hops: 2, via: "CO_ACCESSED_WITH", isInferred: true }
      ]
    });

    const report = await analyzeDistributedImpact(ctx, graph, "checkout", ["svc-a"], 2);
    assert.equal(report.directImpacts.length, 1);
    assert.equal(report.transitiveImpacts.length, 2);
    assert.equal(report.confirmedImpacts.length, 2);
    assert.equal(report.hypotheses.length, 1);
    assert.equal(report.riskLevel, "medium");
  });

  it("does not treat inferred graph relations as confirmed impacts or critical rule coverage", async () => {
    const graph = makeGraph({
      "svc-a": [
        { itemId: "rule-pci", projectId: "checkout", hops: 1, via: "CO_ACCESSED_WITH", isInferred: true },
        { itemId: "svc-b", projectId: "checkout", hops: 2, via: "CO_ACCESSED_WITH", isInferred: true }
      ]
    });

    const report = await analyzeDistributedImpact(ctx, graph, "checkout", ["svc-a"], {
      rules: [{ id: "rule-pci", title: "PCI Audit", priority: "critical", status: "approved" }]
    });

    assert.equal(report.hypotheses.length, 2);
    assert.equal(report.confirmedImpacts.length, 0);
    assert.equal(report.directImpacts.length, 1);
    assert.equal(report.transitiveImpacts.length, 1);
    assert.equal(report.criticalRulesImpacted.length, 0);
    assert.equal(report.riskLevel, "low");
  });

  it("combines cross-service blast radius and critical business rules into riskLevel", async () => {
    const graph = makeGraph({
      "POST /v1/invoices": [
        { itemId: "rule-pci", projectId: "billing", hops: 1, via: "GOVERNED_BY", isInferred: false }
      ]
    });

    const registry = new CrossServiceContractRegistry();
    registry.registerContract({
      tenantId: "t1",
      fromProjectId: "checkout",
      fromService: "checkout-api",
      relation: "CONSUMES_API",
      toProjectId: "billing",
      contractId: "POST /v1/invoices",
      schemaVersion: "1.0.0",
      accessPolicyId: "internal-project"
    });

    const report = await analyzeDistributedImpact(ctx, graph, "billing", ["POST /v1/invoices"], {
      maxDepth: 2,
      crossServiceRegistry: registry,
      rules: [
        { id: "rule-pci", title: "PCI Audit", priority: "critical", status: "approved" },
        { id: "rule-low", title: "Logging", priority: "low", status: "approved" }
      ]
    });

    assert.equal(report.crossServiceImpacts.length, 1);
    assert.deepEqual(report.crossServiceImpacts[0]?.impactedProjects, ["checkout", "billing"]);
    assert.equal(report.criticalRulesImpacted.length, 1);
    assert.equal(report.criticalRulesImpacted[0]?.id, "rule-pci");
    assert.equal(report.riskLevel, "critical");
  });

  it("supports an async cross-service registry used by PostgreSQL-backed deployments", async () => {
    const graph = makeGraph({ "svc-a": [{ itemId: "svc-b", projectId: "checkout", hops: 1, via: "DEPENDS_ON", isInferred: false }] });
    const asyncRegistry = {
      async buildFederatedContextPack() {
        return { projects: ["checkout"], contracts: [{ tenantId: "t1", fromProjectId: "checkout", fromService: "checkout-api", relation: "CONSUMES_API" as const, toProjectId: "billing", contractId: "svc-b", schemaVersion: "1.0.0", accessPolicyId: "internal-project" }] };
      },
      async computeDistributedBlastRadius(_ctx: AuthContext, contractId: string) {
        return { contractId, impactedProjects: ["checkout", "billing"], impactedServices: [{ projectId: "checkout", service: "checkout-api", relation: "CONSUMES_API" as const }] };
      }
    };
    const report = await analyzeDistributedImpact(ctx, graph, "checkout", ["svc-a"], { crossServiceRegistry: asyncRegistry });
    assert.equal(report.crossServiceImpacts.length, 1);
    assert.equal(report.riskLevel, "high");
  });
});
