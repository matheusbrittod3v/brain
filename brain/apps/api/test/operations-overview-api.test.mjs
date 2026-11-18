import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("operations overview reports project health without inventing provider costs", async () => {
  const keys = ["BRAIN_PG_STORES", "BRAIN_PG_BOSS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.BRAIN_PG_STORES = "0";
  process.env.BRAIN_PG_BOSS = "0";
  const app = buildApp("operations-test-key", ["billing"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/projects/billing/operations/overview",
      headers: { authorization: "Bearer operations-test-key" }
    });
    assert.equal(response.statusCode, 200, response.body);
    const overview = response.json();
    assert.equal(overview.projectId, "billing");
    assert.equal(overview.service.api, "ok");
    assert.equal(overview.service.pgBoss, "not_configured");
    assert.ok(Array.isArray(overview.queues.counts));
    assert.equal(overview.finops.actualProviderUsageAvailable, false);
    assert.equal(overview.finops.actualCostUsd, null);
    assert.equal(overview.finops.modelUsage.calls, 0);
    assert.equal(overview.finops.modelUsage.infrastructureCostAvailable, false);
    assert.equal(overview.finops.tokenEstimateMethod, "character_count_divided_by_four");

    const finopsResponse = await app.inject({
      method: "GET", url: "/v1/projects/billing/finops",
      headers: { authorization: "Bearer operations-test-key" }
    });
    assert.equal(finopsResponse.statusCode, 200, finopsResponse.body);
    assert.equal(finopsResponse.json().estimatedMonthlySaasSavingsUsd, null);
    assert.equal(finopsResponse.json().costTrackingAvailable, false);
  } finally {
    await app.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
