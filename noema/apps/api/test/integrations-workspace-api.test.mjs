import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("integration status reports missing setup without exposing configuration secrets", async () => {
  const keys = ["NOEMA_PG_STORES", "NOEMA_PG_BOSS", "NANGO_URL", "NANGO_SECRET_KEY", "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "NOEMA_GITHUB_REPO_MAP_JSON"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.NOEMA_PG_STORES = "0";
  process.env.NOEMA_PG_BOSS = "0";
  const app = buildApp("integration-test-key", ["billing"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "GET", url: "/v1/projects/billing/integrations/status",
      headers: { authorization: "Bearer integration-test-key" }
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.github.state, "needs_configuration");
    assert.equal(result.saas.state, "needs_configuration");
    assert.equal(result.github.privateRepoAuthConfigured, false);
    assert.equal(result.github.webhookConfigured, false);
    assert.equal(JSON.stringify(result).includes("SECRET_KEY"), false);

    const sync = await app.inject({
      method: "POST", url: "/v1/projects/billing/integrations/jira/sync",
      headers: { authorization: "Bearer integration-test-key" },
      payload: { connectionId: "connection-1" }
    });
    assert.equal(sync.statusCode, 503);
  } finally {
    await app.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
