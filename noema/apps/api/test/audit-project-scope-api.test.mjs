import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("audit log query filters to a project and rejects projects outside the actor scope", async () => {
  const keys = ["NOEMA_PG_STORES", "NOEMA_PG_BOSS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NOEMA_PG_STORES = "0";
  process.env.NOEMA_PG_BOSS = "0";
  const logger = new InMemoryAuditLogger();
  const app = buildApp("audit-test-key", ["billing", "marketing"], logger);
  try {
    for (const projectId of ["billing", "marketing"]) {
      const response = await app.inject({
        method: "POST", url: `/v1/projects/${projectId}/ingest`,
        headers: { authorization: "Bearer audit-test-key" },
        payload: { filePath: ".brain/01-business/BR-1.yaml", content: `id: BR-${projectId}\ntype: business_rule\ntitle: ${projectId}\nstatus: draft\naccess_policy: internal-project\ndescription: Test ${projectId}` }
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    const scoped = await app.inject({
      method: "GET", url: "/v1/audit-logs?projectId=billing&limit=10",
      headers: { authorization: "Bearer audit-test-key" }
    });
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.ok(scoped.json().logs.length > 0);
    assert.ok(scoped.json().logs.every((event) => event.projectId === "billing"));

    const profile = await app.inject({
      method: "GET", url: "/v1/projects/billing/access/profile",
      headers: { authorization: "Bearer audit-test-key" }
    });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.equal(profile.json().actorId, "local-dev");
    assert.equal(profile.json().currentProjectAuthorized, true);
    assert.ok(profile.json().roles.includes("admin"));
    assert.ok(profile.json().allowedPolicies.includes("internal-project"));

    const denied = await app.inject({
      method: "GET", url: "/v1/audit-logs?projectId=unknown",
      headers: { authorization: "Bearer audit-test-key" }
    });
    assert.equal(denied.statusCode, 403);

  } finally {
    await app.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
