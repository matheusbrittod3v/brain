import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("API rejects cross-project access on every project route", async () => {
  const app = buildApp("api-secret", ["allowed-project"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer api-secret" };
  const requests = [
    {
      method: "POST",
      url: "/v1/projects/other-project/ingest",
      payload: { filePath: "rule.yaml", content: "id: BR-1\ntype: business_rule\ntitle: Rule\nstatus: draft\n" }
    },
    { method: "POST", url: "/v1/projects/other-project/context", payload: { task: "Review the project" } },
    { method: "GET", url: "/v1/projects/other-project/github/jobs" },
    { method: "POST", url: "/v1/projects/other-project/github/ingest", payload: { owner: "acme", repo: "billing", ref: "main" } },
    { method: "POST", url: "/v1/projects/other-project/runner/tasks", payload: { instruction: "Summarize changes" } },
    {
      method: "POST",
      url: "/v1/projects/other-project/handoffs",
      payload: {
        taskId: "TASK-1", fromAgent: "test", repoUrl: "https://example.test/repo", branch: "main",
        baseCommitSha: "abc", modifiedFiles: [], nextSteps: []
      }
    }
  ];

  try {
    for (const request of requests) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 403, `${request.url} must reject cross-project access`);
    }
  } finally {
    await app.close();
  }
});

test("API denies project access when no trusted project scope is configured", async () => {
  const app = buildApp("api-secret", [], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/allowed-project/context",
      headers: { authorization: "Bearer api-secret" },
      payload: { task: "Review the project" }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("API ingestion records the policy parsed from the ingested item", async () => {
  const audit = new InMemoryAuditLogger();
  const app = buildApp("api-secret", ["allowed-project"], audit);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/allowed-project/ingest",
      headers: { authorization: "Bearer api-secret" },
      payload: {
        filePath: ".brain/rule.yaml",
        content: "id: BR-1\ntype: business_rule\ntitle: Rule\nstatus: draft\naccess_policy: public-org\ndescription: Example.\n"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(audit.events[0]?.accessPolicyId, "public-org");
  } finally {
    await app.close();
  }
});
