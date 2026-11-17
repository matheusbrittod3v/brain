import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
import { buildApp } from "../../apps/api/dist/src/server.js";

const rootUrl = process.env.NOEMA_INTEGRATION_DB_URL;

test("live PostgreSQL coverage follows the persisted GitHub main HEAD and its passing CI result", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.NOEMA_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const projectId = `verified-by-${randomUUID()}`;
  const ruleId = `BR-LIVE-${randomUUID()}`;
  const testPath = `tests/${ruleId.toLowerCase()}.test.ts`;
  const commitSha = "a".repeat(40);
  const nextCommitSha = "c".repeat(40);
  const repository = `acme/${projectId}`;
  const apiKey = "verified-by-live-key";
  const webhookSecret = "verified-by-live-webhook-secret";
  const oldEnv = {
    databaseUrl: process.env.DATABASE_URL,
    databaseSystemUrl: process.env.DATABASE_SYSTEM_URL,
    pgStores: process.env.NOEMA_PG_STORES,
    pgBoss: process.env.NOEMA_PG_BOSS,
    webhook: process.env.NOEMA_CHANNEL_WEBHOOK_SECRET,
    actorMap: process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubRepoMap: process.env.NOEMA_GITHUB_REPO_MAP_JSON
  };
  process.env.DATABASE_URL = appUrl;
  delete process.env.DATABASE_SYSTEM_URL;
  process.env.NOEMA_PG_STORES = "1";
  process.env.NOEMA_PG_BOSS = "1";
  process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = webhookSecret;
  process.env.GITHUB_WEBHOOK_SECRET = "verified-by-github-webhook-secret";
  process.env.NOEMA_GITHUB_REPO_MAP_JSON = JSON.stringify({
    [repository]: { tenantId: "default-org", projectId, accessPolicyId: "internal-project" }
  });
  process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = JSON.stringify({ jira: {
    "ci-live": { actorId: "service:ci-live", tenantId: "default-org", projectIds: [projectId], policyIds: ["internal-project"], roles: ["ci-bot"] }
  } });
  const queued = [];
  const app = buildApp(apiKey, [projectId], undefined, undefined, undefined, async (payload) => {
    queued.push(payload);
    return `job-${queued.length}`;
  });
  const headers = { authorization: `Bearer ${apiKey}` };

  async function sendCi(runId, status, sha = commitSha, executedAt) {
    const payload = {
      eventType: "test.results", projectId, repository, externalUserId: "ci-live", runId, commitSha: sha,
      ...(executedAt ? { executedAt } : {}),
      results: [{ testItemId: testPath, status, durationMs: 17 }]
    };
    const signature = createHmac("sha256", webhookSecret).update(JSON.stringify(payload)).digest("hex");
    return app.inject({ method: "POST", url: "/v1/integrations/jira/events", headers: {
      ...headers, "x-noema-signature-256": `sha256=${signature}`
    }, payload });
  }

  async function sendMainPush(before, after) {
    const payload = {
      ref: "refs/heads/main", before, after, commits: [], repository: { full_name: repository }
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET).update(rawBody).digest("hex");
    return app.inject({ method: "POST", url: "/v1/ingestion/webhooks/github", headers: {
      "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${signature}`
    }, payload: rawBody });
  }

  try {
    await admin`INSERT INTO organizations (id, name) VALUES ('default-org', 'Noema VERIFIED_BY Integration') ON CONFLICT DO NOTHING`;
    const pushedMain = await sendMainPush("0".repeat(40), commitSha);
    assert.equal(pushedMain.statusCode, 200, pushedMain.body);
    assert.equal(pushedMain.json().mainHeadUpdated, true);
    const [storedHead] = await admin`SELECT repository, branch, commit_sha FROM project_repository_heads WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    assert.deepEqual(storedHead, { repository, branch: "main", commit_sha: commitSha });
    const initialStatus = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/integrations/status`, headers });
    assert.equal(initialStatus.json().github.mainHeads[0].commitSha, commitSha);
    const rule = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/ingest`, headers,
      payload: { filePath: `.brain/01-business/${ruleId}.yaml`, commitSha,
        content: `id: ${ruleId}\ntype: business_rule\ntitle: Live coverage rule\nstatus: approved\naccess_policy: internal-project\npriority: high\ndescription: Synthetic integration evidence.\n` }
    });
    assert.equal(rule.statusCode, 200, rule.body);
    const testItem = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/ingest`, headers,
      payload: { filePath: testPath, commitSha,
        content: `// @brain-rule ${ruleId}\nit("covers the live rule", () => {});\n` }
    });
    assert.equal(testItem.statusCode, 200, testItem.body);

    const getCoverage = async () => {
      const response = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/enterprise/views`, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().qaCoverage.rows.find((row) => row.ruleId === ruleId);
    };
    assert.equal((await getCoverage()).covered, false, "a graph edge alone is not coverage");
    const passed = await sendCi("run-pass", "passed");
    assert.equal(passed.statusCode, 200, passed.body);
    assert.equal((await getCoverage()).covered, true, "the current main HEAD passed in CI");
    const stale = await sendCi("run-stale", "passed", "b".repeat(40), "2098-01-01T00:00:00.000Z");
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal((await getCoverage()).covered, true, "a later green result from another SHA cannot displace main evidence");
    const failed = await sendCi("run-failed", "failed", commitSha, "2099-01-01T00:00:00.000Z");
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal((await getCoverage()).covered, false, "a newer failed result invalidates coverage");
    const advancedMain = await sendMainPush(commitSha, nextCommitSha);
    assert.equal(advancedMain.statusCode, 200, advancedMain.body);
    assert.equal(advancedMain.json().mainHeadUpdated, true);
    const advancedStatus = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/integrations/status`, headers });
    assert.equal(advancedStatus.json().github.mainHeads[0].commitSha, nextCommitSha);
    assert.equal((await getCoverage()).covered, false, "moving main invalidates old green evidence even if the test file snapshot is unchanged");
    const currentPass = await sendCi("run-next-main-pass", "passed", nextCommitSha);
    assert.equal(currentPass.statusCode, 200, currentPass.body);
    assert.equal((await getCoverage()).covered, true, "CI at the new main HEAD restores coverage");
    const delayedMain = await sendMainPush(commitSha, "d".repeat(40));
    assert.equal(delayedMain.statusCode, 200, delayedMain.body);
    assert.equal(delayedMain.json().ignored, true, "a delayed push cannot roll the persisted main HEAD backward");
    assert.equal(queued.length, 2, "only the initial and current main pushes are queued");
    const deletedMain = await sendMainPush(nextCommitSha, "0".repeat(40));
    assert.equal(deletedMain.statusCode, 200, deletedMain.body);
    assert.equal(deletedMain.json().mainHeadUpdated, true, "deleting main removes its persisted HEAD");
    const deletedStatus = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/integrations/status`, headers });
    assert.deepEqual(deletedStatus.json().github.mainHeads, []);
    assert.equal((await getCoverage()).covered, false, "coverage fails closed after main is deleted");
  } finally {
    await app.close();
    await admin`DELETE FROM project_repository_heads WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM test_execution_results WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_relations WHERE tenant_id = 'default-org' AND (from_project_id = ${projectId} OR to_project_id = ${projectId})`;
    await admin`DELETE FROM knowledge_embeddings WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_item_versions WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM sync_changes WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM audit_logs WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin`DELETE FROM knowledge_items WHERE tenant_id = 'default-org' AND project_id = ${projectId}`;
    await admin.end();
    if (oldEnv.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldEnv.databaseUrl;
    if (oldEnv.databaseSystemUrl === undefined) delete process.env.DATABASE_SYSTEM_URL; else process.env.DATABASE_SYSTEM_URL = oldEnv.databaseSystemUrl;
    if (oldEnv.pgStores === undefined) delete process.env.NOEMA_PG_STORES; else process.env.NOEMA_PG_STORES = oldEnv.pgStores;
    if (oldEnv.pgBoss === undefined) delete process.env.NOEMA_PG_BOSS; else process.env.NOEMA_PG_BOSS = oldEnv.pgBoss;
    if (oldEnv.webhook === undefined) delete process.env.NOEMA_CHANNEL_WEBHOOK_SECRET; else process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = oldEnv.webhook;
    if (oldEnv.actorMap === undefined) delete process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON; else process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = oldEnv.actorMap;
    if (oldEnv.githubWebhookSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = oldEnv.githubWebhookSecret;
    if (oldEnv.githubRepoMap === undefined) delete process.env.NOEMA_GITHUB_REPO_MAP_JSON; else process.env.NOEMA_GITHUB_REPO_MAP_JSON = oldEnv.githubRepoMap;
  }
});
