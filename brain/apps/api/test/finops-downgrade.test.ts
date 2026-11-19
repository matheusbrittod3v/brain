import test from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "@brain/auth";
import { evaluateFinopsQuotas, parseProviderModelSpec, resolveActiveFinopsDowngrade } from "../src/services/finops-quota.js";

const ctx: AuthContext = {
  tenantId: "default-org",
  actorId: "usr-dev-1",
  actorType: "human",
  roles: ["developer"],
  allowedProjects: ["brain"],
  allowedPolicies: ["internal-project"]
};

test("detects exceeded quota and resolves automatic downgrade model", async () => {
  const mockOpRepo = {
    listDepartmentFinopsQuotas: async () => [
      {
        department: "engineering",
        monthlyTokenLimit: 1000,
        monthlyUsdLimit: 5,
        downgradeModel: "ollama:gemma2:2b",
        updatedAt: new Date().toISOString()
      }
    ]
  } as any;

  const exceeded = await resolveActiveFinopsDowngrade({
    ctx,
    projectId: "brain",
    opRepo: mockOpRepo,
    projectModelUsage: async () => ({
      calls: 50,
      providerCostUsd: 8.5,
      byModel: [{ totalTokens: 5000 }]
    })
  });

  assert.equal(exceeded.downgraded, true);
  assert.equal(exceeded.provider, "ollama");
  assert.equal(exceeded.model, "gemma2:2b");
  assert.equal(exceeded.department, "engineering");

  const ok = await resolveActiveFinopsDowngrade({
    ctx,
    projectId: "brain",
    opRepo: mockOpRepo,
    projectModelUsage: async () => ({
      calls: 2,
      providerCostUsd: 0.1,
      byModel: [{ totalTokens: 100 }]
    })
  });

  assert.equal(ok.downgraded, false);
});

test("parses provider:model specs and evaluates quota thresholds deterministically", () => {
  assert.deepEqual(parseProviderModelSpec("ollama:qwen2.5-coder:7b"), {
    provider: "ollama",
    model: "qwen2.5-coder:7b"
  });
  assert.deepEqual(parseProviderModelSpec("gemma2:2b"), {
    provider: "ollama",
    model: "gemma2:2b"
  });

  const evaluated = evaluateFinopsQuotas(
    [{ department: "qa", monthlyTokenLimit: 100, monthlyUsdLimit: 10, updatedAt: "2026-11-19T00:00:00Z" }],
    { calls: 1, providerCostUsd: 0.5, byModel: [{ totalTokens: 250 }] }
  );
  assert.equal(evaluated[0]?.withinQuota, false);
  assert.ok(evaluated[0]?.recommendedDowngradeModel);
});
