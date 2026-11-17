import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("GitHub push webhook verifies raw body, resolves trusted scope, queues pinned commit, and audits", async () => {
  const previous = {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    map: process.env.NOEMA_GITHUB_REPO_MAP_JSON,
    boss: process.env.NOEMA_PG_BOSS
  };
  process.env.GITHUB_WEBHOOK_SECRET = "github-test-secret";
  process.env.NOEMA_GITHUB_REPO_MAP_JSON = JSON.stringify({
    "Acme/Billing": { tenantId: "acme", projectId: "billing", accessPolicyId: "internal-project" }
  });
  process.env.NOEMA_PG_BOSS = "1";
  const audit = new InMemoryAuditLogger();
  const queued = [];
  const app = buildApp("github-webhook-test-key", ["billing"], audit, undefined, undefined, async (payload) => {
    queued.push(payload);
    return "job-123";
  });
  const rawBody = JSON.stringify({
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: "0123456789abcdef0123456789abcdef01234567",
    commits: [{ added: ["README.md"], modified: ["src/billing.ts"] }],
    repository: { full_name: "acme/billing" }
  });
  const signature = `sha256=${createHmac("sha256", "github-test-secret").update(rawBody).digest("hex")}`;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/ingestion/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": signature },
      payload: rawBody
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().jobId, "job-123");
    assert.deepEqual(queued, [{
      tenantId: "acme", projectId: "billing", accessPolicyId: "internal-project",
      owner: "acme", repo: "billing", ref: "0123456789abcdef0123456789abcdef01234567",
      branch: "main", beforeCommitSha: "0".repeat(40)
    }]);
    assert.equal(response.json().mainHeadUpdated, true, "a signed main push establishes the project head");
    assert.equal(audit.events.length, 1);
    assert.equal(audit.events[0].targetId, "job-123");

    const sendPush = async (payload) => {
      const body = JSON.stringify(payload);
      const sig = `sha256=${createHmac("sha256", "github-test-secret").update(body).digest("hex")}`;
      return app.inject({ method: "POST", url: "/v1/ingestion/webhooks/github", headers: {
        "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sig
      }, payload: body });
    };
    const invalidBefore = await sendPush({
      ref: "refs/heads/main", before: "not-a-sha", after: "5555555555555555555555555555555555555555",
      commits: [], repository: { full_name: "acme/billing" }
    });
    assert.equal(invalidBefore.statusCode, 422);
    const featurePush = await sendPush({
      ref: "refs/heads/feature/no-main-update", before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222", commits: [], repository: { full_name: "acme/billing" }
    });
    assert.equal(featurePush.statusCode, 200, featurePush.body);
    assert.equal(featurePush.json().mainHeadUpdated, false);
    const nextMainSha = "3333333333333333333333333333333333333333";
    const nextMainPush = await sendPush({
      ref: "refs/heads/main", before: "0123456789abcdef0123456789abcdef01234567",
      after: nextMainSha, commits: [], repository: { full_name: "acme/billing" }
    });
    assert.equal(nextMainPush.statusCode, 200, nextMainPush.body);
    assert.equal(nextMainPush.json().mainHeadUpdated, true);
    const delayedPush = await sendPush({
      ref: "refs/heads/main", before: "0123456789abcdef0123456789abcdef01234567",
      after: "4444444444444444444444444444444444444444", commits: [], repository: { full_name: "acme/billing" }
    });
    assert.equal(delayedPush.json().ignored, true, "an out-of-order push cannot roll main backward");
    assert.equal(queued.length, 3, "the stale push is not queued for ingestion");
  } finally {
    await app.close();
    if (previous.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previous.secret;
    if (previous.map === undefined) delete process.env.NOEMA_GITHUB_REPO_MAP_JSON;
    else process.env.NOEMA_GITHUB_REPO_MAP_JSON = previous.map;
    if (previous.boss === undefined) delete process.env.NOEMA_PG_BOSS;
    else process.env.NOEMA_PG_BOSS = previous.boss;
  }
});

test("GitHub webhook rejects invalid signatures and unmapped repositories", async () => {
  const previous = {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    map: process.env.NOEMA_GITHUB_REPO_MAP_JSON,
    boss: process.env.NOEMA_PG_BOSS
  };
  process.env.GITHUB_WEBHOOK_SECRET = "github-test-secret";
  process.env.NOEMA_GITHUB_REPO_MAP_JSON = "{}";
  process.env.NOEMA_PG_BOSS = "1";
  const app = buildApp("github-webhook-test-key", ["billing"], new InMemoryAuditLogger(), undefined, undefined, async () => "job-123");
  const rawBody = JSON.stringify({
    ref: "refs/heads/main", after: "0123456789abcdef0123456789abcdef01234567", commits: [],
    repository: { full_name: "acme/billing" }
  });
  const validSignature = `sha256=${createHmac("sha256", "github-test-secret").update(rawBody).digest("hex")}`;

  try {
    const badSignature = await app.inject({
      method: "POST", url: "/v1/ingestion/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": "sha256=bad" },
      payload: rawBody
    });
    assert.equal(badSignature.statusCode, 401);
    const unmapped = await app.inject({
      method: "POST", url: "/v1/ingestion/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": validSignature },
      payload: rawBody
    });
    assert.equal(unmapped.statusCode, 403);
  } finally {
    await app.close();
    if (previous.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = previous.secret;
    if (previous.map === undefined) delete process.env.NOEMA_GITHUB_REPO_MAP_JSON;
    else process.env.NOEMA_GITHUB_REPO_MAP_JSON = previous.map;
    if (previous.boss === undefined) delete process.env.NOEMA_PG_BOSS;
    else process.env.NOEMA_PG_BOSS = previous.boss;
  }
});
