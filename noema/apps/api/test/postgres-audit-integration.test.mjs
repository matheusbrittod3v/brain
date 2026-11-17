import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../dist/src/server.js";

test("API requires PostgreSQL audit configuration instead of silently defaulting to memory", () => {
  const configuredUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => buildApp("api-secret", ["allowed-project"]), /DATABASE_URL is required/);
  } finally {
    if (configuredUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = configuredUrl;
  }
});

test("API writes the ingested item policy through the app client with trusted RLS context", async () => {
  const transactions = [];
  const fakeAppClient = {
    role: "brain_app",
    async withRlsTransaction(context, callback) {
      transactions.push({ context, inserts: [] });
      const transaction = async (strings, ...parameters) => {
        transactions.at(-1).inserts.push({ sql: strings.join(" ? "), parameters });
      };
      await callback(transaction);
    },
    async close() {}
  };
  const app = buildApp("api-secret", ["allowed-project"], undefined, () => fakeAppClient);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/allowed-project/ingest",
      headers: { authorization: "Bearer api-secret" },
      payload: {
        filePath: ".brain/rule.yaml",
        content: "id: BR-1\ntype: business_rule\ntitle: Rule\nstatus: draft\naccess_policy: public-org\n"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(transactions[0]?.context, {
      tenantId: "default-org",
      allowedProjects: ["allowed-project"],
      allowedPolicies: ["public-org", "internal-project", "confidential-business"]
    });
    assert.equal(transactions[0]?.inserts.length, 1);
    assert.match(transactions[0]?.inserts[0]?.sql ?? "", /INSERT INTO audit_logs/);
    assert.ok(transactions[0]?.inserts[0]?.parameters.includes("public-org"));
  } finally {
    await app.close();
  }
});
