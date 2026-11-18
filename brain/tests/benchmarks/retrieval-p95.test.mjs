import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { KnowledgeGraphStore } from "../../packages/graph/dist/src/index.js";
import { HybridRetrievalEngine } from "../../packages/retrieval/dist/src/index.js";

describe("retrieval p95 latency benchmark", () => {
  it("measures p95 latency below 150ms across 1,000 indexed chunks", () => {
    const graph = new KnowledgeGraphStore();
    const retrieval = new HybridRetrievalEngine(graph);
    const now = new Date().toISOString();

    for (let i = 0; i < 1000; i += 1) {
      retrieval.upsertItem({
        id: `BENCH-${i}`,
        tenantId: "bench-org",
        projectId: "bench-proj",
        domainId: 2,
        type: "business_rule",
        title: `Regra de negócio ${i}`,
        content: `Regra de precificação e desconto corporativo item ${i} com cálculo determinístico.`,
        status: "approved",
        sourceId: "git",
        sourceOrigin: "internal",
        sourceKind: "git",
        sourceVersion: "v1",
        sourceUri: `.brain/bench-${i}.md`,
        version: 1,
        contentHash: `hash-${i}`,
        confidence: 1,
        trustLevel: "verified",
        isInferred: false,
        tags: ["benchmark"],
        accessPolicyId: "internal-project",
        relatedIds: [],
        metadata: {},
        createdAt: now,
        updatedAt: now
      });
    }

    const ctx = {
      tenantId: "bench-org",
      actorId: "bench",
      actorType: "human",
      roles: ["developer"],
      allowedProjects: ["bench-proj"],
      allowedPolicies: ["internal-project"]
    };

    const latencies = [];
    for (let q = 0; q < 50; q += 1) {
      const start = performance.now();
      const hits = retrieval.search(ctx, { projectId: "bench-proj", query: "desconto corporativo", limit: 10 });
      latencies.push(performance.now() - start);
      assert.ok(hits.length > 0);
    }

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    assert.ok(p95 < 150, `p95 latency (${p95.toFixed(2)}ms) exceeded 150ms`);
  });
});

