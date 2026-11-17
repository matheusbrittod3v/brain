import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("Teams, Jira, ClickUp, and Email interactive actions enter canonical approval flow", async () => {
  const previousSecret = process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
  const previousMap = process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
  process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = "channel-test-secret";
  process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = JSON.stringify({
    teams: { "teams-u1": { actorId: "person:teams-1", tenantId: "default-org", roles: ["tech-lead"], projectIds: ["noema"], policyIds: ["internal-project"] } },
    jira: { "jira-u1": { actorId: "person:jira-1", tenantId: "default-org", roles: ["tech-lead"], projectIds: ["noema"], policyIds: ["internal-project"] } },
    clickup: { "cu-u1": { actorId: "person:cu-1", tenantId: "default-org", roles: ["tech-lead"], projectIds: ["noema"], policyIds: ["internal-project"] } },
    email: { "email-u1": { actorId: "person:email-1", tenantId: "default-org", roles: ["tech-lead"], projectIds: ["noema"], policyIds: ["internal-project"] } }
  });
  const apiKey = "channel-actions-test-key";
  const audit = new InMemoryAuditLogger();
  const app = buildApp(apiKey, ["noema"], audit);

  try {
    const channels = [
      { channel: "teams", userId: "teams-u1", decision: "approve" },
      { channel: "jira", userId: "jira-u1", decision: "request_changes" },
      { channel: "clickup", userId: "cu-u1", decision: "reject" },
      { channel: "email", userId: "email-u1", decision: "approve" }
    ];

    for (const [idx, entry] of channels.entries()) {
      const proposeRes = await app.inject({
        method: "POST",
        url: "/v1/projects/noema/change/propose",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { title: `Proposal ${idx}`, content: `Rule content ${idx}`, targetType: "business_rule" }
      });
      assert.equal(proposeRes.statusCode, 200);
      const { proposalId } = proposeRes.json();

      const body = JSON.stringify({
        action: `noema_${entry.decision}`,
        projectId: "noema",
        proposalId,
        proposalVersion: 1,
        externalUserId: entry.userId,
        externalEventId: `evt-${entry.channel}-${idx}`
      });
      const sig = `sha256=${createHmac("sha256", "channel-test-secret").update(body, "utf8").digest("hex")}`;
      const actionRes = await app.inject({
        method: "POST",
        url: `/v1/integrations/${entry.channel}/actions`,
        headers: { "content-type": "application/json", "x-noema-signature-256": sig },
        payload: body
      });
      assert.equal(actionRes.statusCode, 200, actionRes.body);
      assert.equal(actionRes.json().accepted, true);
      assert.equal(actionRes.json().channel, entry.channel);
    }
  } finally {
    await app.close();
    if (previousSecret === undefined) delete process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    else process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = previousSecret;
    if (previousMap === undefined) delete process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
    else process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = previousMap;
  }
});

test("Runner task cancel and cross-service contracts listing work with project isolation", async () => {
  const apiKey = "command-center-endpoints-test-key";
  const audit = new InMemoryAuditLogger();
  const app = buildApp(apiKey, ["noema"], audit);
  try {
    const enqueueRes = await app.inject({
      method: "POST",
      url: "/v1/projects/noema/runner/tasks",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { instruction: "Gerar resumo da arquitetura", priority: "normal" }
    });
    assert.equal(enqueueRes.statusCode, 200);
    const taskId = enqueueRes.json().taskId;

    const cancelRes = await app.inject({
      method: "POST",
      url: `/v1/projects/noema/runner/tasks/${taskId}/cancel`,
      headers: { authorization: `Bearer ${apiKey}` }
    });
    assert.equal(cancelRes.statusCode, 200, cancelRes.body);
    assert.equal(cancelRes.json().status, "cancelled");

    const regRes = await app.inject({
      method: "POST",
      url: "/v1/cross-service/contracts",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        fromProjectId: "noema",
        fromService: "noema-api",
        relation: "CONSUMES_API",
        toProjectId: "noema",
        contractId: "POST /v1/projects/:id/context"
      }
    });
    assert.equal(regRes.statusCode, 200);

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/cross-service/contracts?projectId=noema",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().contracts.length, 1);
    assert.equal(listRes.json().contracts[0].contractId, "POST /v1/projects/:id/context");
  } finally {
    await app.close();
  }
});

