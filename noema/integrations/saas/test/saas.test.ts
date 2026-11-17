import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  dispatchChannelNotification,
  mapSaasRecordToKnowledgeItem,
  parseChannelActionPayload,
  verifySlackRequestSignature,
  verifyChannelWebhookSignature
} from "../src/index.js";

test("maps Jira/Slack records as untrusted and fail-closed on unmapped private ACL", () => {
  const jira = mapSaasRecordToKnowledgeItem({
    provider: "jira",
    externalId: "SUB-482",
    tenantId: "acme",
    projectId: "sub",
    title: "Implementar cancelamento",
    body: "Critério: validar chargeback.",
    url: "https://jira.example/SUB-482"
  });
  assert.equal(jira.type, "task");
  assert.equal(jira.trustLevel, "untrusted");
  assert.equal(jira.accessPolicyId, "internal-project");

  const slackPrivate = mapSaasRecordToKnowledgeItem({
    provider: "slack",
    externalId: "C999-123",
    tenantId: "acme",
    projectId: "sub",
    title: "Discussão incidente",
    body: "Dados sensíveis",
    url: "https://slack.example/archives/C999",
    isPrivateChannelOrSpace: true
  });
  assert.equal(slackPrivate.accessPolicyId, "restricted-security");
});

test("maps gitlab, bitbucket, google-drive, grafana, and teams with fail-closed unmapped private ACL", () => {
  const gitlab = mapSaasRecordToKnowledgeItem({
    provider: "gitlab",
    externalId: "MR-101",
    tenantId: "acme",
    projectId: "sub",
    title: "MR 101",
    body: "Pipeline update",
    url: "https://gitlab.example/mr/101"
  });
  assert.equal(gitlab.domainId, 4);
  assert.equal(gitlab.type, "integration");
  assert.equal(gitlab.accessPolicyId, "internal-project");

  const bitbucket = mapSaasRecordToKnowledgeItem({
    provider: "bitbucket",
    externalId: "PR-55",
    tenantId: "acme",
    projectId: "sub",
    title: "PR 55",
    body: "Repo sync",
    url: "https://bitbucket.example/pr/55",
    externalGroup: "private-security-team",
    aclPolicyMap: { "eng-public": "internal-project" }
  });
  assert.equal(bitbucket.domainId, 4);
  assert.equal(bitbucket.type, "integration");
  assert.equal(bitbucket.accessPolicyId, "restricted-security");

  const gdrive = mapSaasRecordToKnowledgeItem({
    provider: "google-drive",
    externalId: "DOC-9",
    tenantId: "acme",
    projectId: "sub",
    title: "RFC Checkout",
    body: "Spec",
    url: "https://drive.google.com/file/d/9",
    isPrivateChannelOrSpace: true
  });
  assert.equal(gdrive.domainId, 2);
  assert.equal(gdrive.type, "document");
  assert.equal(gdrive.accessPolicyId, "restricted-security");

  const grafana = mapSaasRecordToKnowledgeItem({
    provider: "grafana",
    externalId: "ALERT-7",
    tenantId: "acme",
    projectId: "sub",
    title: "High 5xx rate",
    body: "SLO breach",
    url: "https://grafana.example/alert/7"
  });
  assert.equal(grafana.domainId, 8);
  assert.equal(grafana.type, "risk");

  const teams = mapSaasRecordToKnowledgeItem({
    provider: "teams",
    externalId: "MSG-44",
    tenantId: "acme",
    projectId: "sub",
    title: "Release thread",
    body: "Go/No-Go",
    url: "https://teams.microsoft.com/l/message/44",
    externalGroup: "exec-channel",
    aclPolicyMap: { "exec-channel": "restricted-exec" }
  });
  assert.equal(teams.domainId, 7);
  assert.equal(teams.type, "document");
  assert.equal(teams.accessPolicyId, "restricted-exec");
});

test("HumanOps channel signature verification and notification dispatch", async () => {
  const payload = JSON.stringify({ eventType: "approval.decision", proposalId: "PROP-1", approved: true });
  const secret = "channel-webhook-secret";
  const sig = `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
  assert.equal(verifyChannelWebhookSignature(payload, sig, secret), true);
  assert.equal(verifyChannelWebhookSignature(payload, "sha256=deadbeef", secret), false);

  let sentBody: string | undefined;
  const result = await dispatchChannelNotification(
    {
      channel: "slack",
      webhookUrl: "https://hooks.slack.example/services/T0/B0/X",
      projectId: "noema",
      proposalId: "PROP-1",
      proposalVersion: 3,
      title: "Regra PIX",
      reviewUrl: "http://localhost:3000",
      message: "Resumo diário: Regra PIX e Regra boleto"
    },
    async (_url, init) => {
      sentBody = String(init?.body ?? "");
      return new Response("ok", { status: 200 });
    }
  );
  assert.equal(result.delivered, true);
  assert.equal(result.channel, "slack");
  assert.equal(sentBody?.includes("Resumo diário: Regra PIX e Regra boleto"), true);
  const slackMessage = JSON.parse(sentBody ?? "{}") as { blocks?: Array<{ elements?: Array<{ action_id: string; value: string }> }> };
  assert.deepEqual(slackMessage.blocks?.[1]?.elements?.map((element) => element.action_id), [
    "noema_approve", "noema_reject", "noema_request_changes"
  ]);
  assert.equal(JSON.parse(slackMessage.blocks?.[1]?.elements?.[0]?.value ?? "{}").proposalVersion, 3);
});

test("verifies Slack signed requests with a short replay window", () => {
  const secret = "slack-signing-secret";
  const timestamp = "1700000000";
  const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const base = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${createHmac("sha256", secret).update(base, "utf8").digest("hex")}`;
  const futureTimestamp = "1700000050";
  const futureSignature = `v0=${createHmac("sha256", secret).update(`v0:${futureTimestamp}:${rawBody}`, "utf8").digest("hex")}`;
  assert.equal(verifySlackRequestSignature(rawBody, timestamp, signature, secret, 1_700_000_010), true);
  assert.equal(verifySlackRequestSignature(rawBody, timestamp, signature, secret, 1_700_000_400), false);
  assert.equal(verifySlackRequestSignature(rawBody, futureTimestamp, futureSignature, secret, 1_700_000_010), false);
  assert.equal(verifySlackRequestSignature(rawBody, timestamp, "v0=bad", secret, 1_700_000_010), false);
});


test("dispatches native Adaptive Cards (Teams), ADF (Jira), ClickUp, and Email payloads and parses callbacks", async () => {
  const sent: Record<string, Record<string, unknown>> = {};
  for (const channel of ["teams", "jira", "clickup", "email"] as const) {
    await dispatchChannelNotification(
      {
        channel,
        webhookUrl: `https://hooks.example/${channel}`,
        projectId: "noema",
        proposalId: "PROP-9",
        proposalVersion: 2,
        title: "Aprovar ADR-010",
        reviewUrl: "http://localhost:3000/proposals/PROP-9"
      },
      async (_url, init) => {
        sent[channel] = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      }
    );
  }

  // Teams Adaptive Card
  const teamsCard = sent.teams as { attachments?: Array<{ contentType?: string; content?: { type?: string; actions?: Array<{ type?: string }> } }> };
  assert.equal(teamsCard.attachments?.[0]?.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(teamsCard.attachments?.[0]?.content?.type, "AdaptiveCard");
  assert.equal(teamsCard.attachments?.[0]?.content?.actions?.some((a) => a.type === "Action.Execute"), true);

  // Jira ADF
  const jiraPayload = sent.jira as { body?: { type?: string; version?: number }; properties?: Array<{ key?: string }> };
  assert.equal(jiraPayload.body?.type, "doc");
  assert.equal(jiraPayload.body?.version, 1);
  assert.equal(jiraPayload.properties?.[0]?.key, "noema.humanops");

  // ClickUp
  assert.equal(typeof (sent.clickup as { comment_text?: string }).comment_text, "string");
  assert.equal((sent.clickup as { notify_all?: boolean }).notify_all, true);

  // Email
  assert.match(String((sent.email as { subject?: string }).subject), /Aprovar ADR-010/);
  assert.equal(Array.isArray((sent.email as { actionLinks?: unknown[] }).actionLinks), true);

  // Native callback parsing
  const parsedTeams = parseChannelActionPayload("teams", {
    id: "evt-teams-1",
    from: { id: "aad-user-1" },
    action: {
      verb: "noema_approve",
      data: { projectId: "noema", proposalId: "PROP-9", proposalVersion: 2 }
    }
  });
  assert.deepEqual(parsedTeams, {
    decision: "approve",
    projectId: "noema",
    proposalId: "PROP-9",
    proposalVersion: 2,
    externalUserId: "aad-user-1",
    externalEventId: "evt-teams-1"
  });

  const parsedJira = parseChannelActionPayload("jira", {
    webhookEvent: "comment_created",
    timestamp: 1700000100,
    action: "noema_reject",
    user: { accountId: "jira-acc-7" },
    issue: { properties: { "noema.humanops": { projectId: "noema", proposalId: "PROP-9", proposalVersion: 2 } } },
    comment: { body: "Falta cobertura de testes" }
  });
  assert.equal(parsedJira?.decision, "reject");
  assert.equal(parsedJira?.externalUserId, "jira-acc-7");
  assert.equal(parsedJira?.comment, "Falta cobertura de testes");
});

test("maps clickup, github-projects, database schemas, and cloud infra providers with fail-closed ACL", () => {
  for (const provider of ["clickup", "github-projects", "postgresql", "supabase", "mysql", "aws", "gcp", "azure"] as const) {
    const item = mapSaasRecordToKnowledgeItem({
      provider,
      externalId: `${provider}-1`,
      tenantId: "acme",
      projectId: "core",
      title: `Item from ${provider}`,
      body: "Resource metadata",
      url: `https://example.com/${provider}/1`,
      isPrivateChannelOrSpace: true
    });
    assert.equal(item.accessPolicyId, "restricted-security");
    assert.equal(item.trustLevel, "untrusted");
  }
});
