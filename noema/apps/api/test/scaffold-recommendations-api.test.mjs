import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("scaffold recommendations include only approved internal architecture decisions", async () => {
  const keys = ["NOEMA_PG_STORES", "NOEMA_PG_BOSS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NOEMA_PG_STORES = "0";
  process.env.NOEMA_PG_BOSS = "0";
  const app = buildApp("scaffold-test-key", ["billing"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer scaffold-test-key" };
  try {
    for (const [filePath, content] of [
      [".brain/03-architecture/decisions/ADR-BILLING-001.md", "---\nid: ADR-BILLING-001\ntype: architecture_decision\ntitle: Billing usa eventos\nstatus: approved\naccess_policy: internal-project\n---\n\nPara billing, use eventos assíncronos."],
      [".brain/03-architecture/decisions/ADR-BILLING-DRAFT.md", "---\nid: ADR-BILLING-DRAFT\ntype: architecture_decision\ntitle: Billing draft\nstatus: draft\naccess_policy: internal-project\n---\n\nAinda não aprovada."],
      [".brain/01-business/BR-BILLING-001.yaml", "id: BR-BILLING-001\ntype: business_rule\ntitle: Billing rule\nstatus: approved\naccess_policy: internal-project\ndescription: Regra de billing."]
    ]) {
      const response = await app.inject({
        method: "POST", url: "/v1/projects/billing/ingest", headers,
        payload: { filePath, content }
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    const response = await app.inject({
      method: "GET", url: "/v1/projects/billing/scaffold/recommendations?domain=billing&stack=node-ts",
      headers
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].id, "ADR-BILLING-001");
    assert.equal(result.recommendations[0].status, "approved");
    assert.equal(result.recommendations[0].sourceOrigin, "internal");
    assert.equal(result.recommendations[0].sourceUri, ".brain/03-architecture/decisions/ADR-BILLING-001.md");
  } finally {
    await app.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
