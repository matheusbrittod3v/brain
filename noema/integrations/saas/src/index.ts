import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { KnowledgeItem } from "@noema/core";

export type SaasProvider =
  | "jira"
  | "linear"
  | "notion"
  | "confluence"
  | "figma"
  | "sentry"
  | "datadog"
  | "hubspot"
  | "salesforce"
  | "slack"
  | "gitlab"
  | "bitbucket"
  | "google-drive"
  | "grafana"
  | "teams";

const PROVIDER_DEFAULTS: Record<SaasProvider, { domainId: number; type: KnowledgeItem["type"] }> = {
  jira: { domainId: 6, type: "task" },
  linear: { domainId: 6, type: "task" },
  notion: { domainId: 2, type: "document" },
  confluence: { domainId: 2, type: "document" },
  figma: { domainId: 2, type: "document" },
  "google-drive": { domainId: 2, type: "document" },
  sentry: { domainId: 8, type: "risk" },
  datadog: { domainId: 8, type: "risk" },
  grafana: { domainId: 8, type: "risk" },
  hubspot: { domainId: 9, type: "document" },
  salesforce: { domainId: 9, type: "document" },
  slack: { domainId: 7, type: "document" },
  teams: { domainId: 7, type: "document" },
  gitlab: { domainId: 4, type: "integration" },
  bitbucket: { domainId: 4, type: "integration" }
};

export interface ExternalSaasRecord {
  provider: SaasProvider;
  externalId: string;
  tenantId: string;
  projectId: string;
  title: string;
  body: string;
  url: string;
  isPrivateChannelOrSpace?: boolean;
  aclPolicyMap?: Record<string, string>;
  externalGroup?: string;
}

/**
 * Converte payloads de conectores SaaS (via Nango) para KnowledgeItem com fail-closed ACL.
 */
export function mapSaasRecordToKnowledgeItem(rec: ExternalSaasRecord): KnowledgeItem {
  const now = new Date().toISOString();
  const mappedPolicy =
    rec.externalGroup && rec.aclPolicyMap?.[rec.externalGroup]
      ? rec.aclPolicyMap[rec.externalGroup]
      : rec.isPrivateChannelOrSpace || rec.externalGroup
        ? "restricted-security"
        : "internal-project";

  const { domainId, type } = PROVIDER_DEFAULTS[rec.provider];

  return {
    id: `${rec.provider.toUpperCase()}-${rec.externalId}`,
    tenantId: rec.tenantId,
    projectId: rec.projectId,
    domainId,
    type,
    title: rec.title,
    content: rec.body,
    status: "draft",
    sourceId: `${rec.provider}:${rec.externalId}`,
    sourceOrigin: "internal",
    sourceKind: "connector",
    sourceVersion: "v1",
    sourceUri: rec.url,
    version: 1,
    contentHash: createHash("sha256").update(`${rec.title}\n${rec.body}`).digest("hex"),
    confidence: 0.85,
    trustLevel: "untrusted",
    isInferred: false,
    tags: [rec.provider],
    relatedIds: [],
    accessPolicyId: mappedPolicy,
    metadata: { externalProvider: rec.provider, externalId: rec.externalId },
    createdAt: now,
    updatedAt: now
  };
}

export async function fetchNangoRecords(
  nangoUrl: string,
  secretKey: string,
  providerConfigKey: string,
  connectionId: string,
  model: string,
  fetchFn: typeof fetch = fetch
): Promise<Array<Record<string, unknown>>> {
  const res = await fetchFn(
    `${nangoUrl.replace(/\/$/, "")}/records?model=${encodeURIComponent(model)}`,
    {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Provider-Config-Key": providerConfigKey,
        "Connection-Id": connectionId
      }
    }
  );
  if (!res.ok) {
    throw new Error(`Nango sync falhou (${res.status}) para ${providerConfigKey}.`);
  }
  const body = (await res.json()) as { records?: Array<Record<string, unknown>> };
  return body.records ?? [];
}

export function handleSaasWebhook(
  provider: SaasProvider,
  payload: { id?: string; externalId?: string; tenantId?: string; projectId?: string; title?: string; body?: string; url?: string; private?: boolean }
): KnowledgeItem {
  return mapSaasRecordToKnowledgeItem({
    provider,
    externalId: payload.externalId ?? payload.id ?? "webhook-item",
    tenantId: payload.tenantId ?? "default-org",
    projectId: payload.projectId ?? "default",
    title: payload.title ?? `${provider} event`,
    body: payload.body ?? JSON.stringify(payload),
    url: payload.url ?? `https://${provider}.example.com`,
    isPrivateChannelOrSpace: Boolean(payload.private)
  });
}

export type HumanOpsChannel = "slack" | "teams" | "jira" | "clickup" | "email";

export interface ChannelNotificationInput {
  channel: HumanOpsChannel;
  webhookUrl: string;
  projectId: string;
  proposalId: string;
  proposalVersion?: number;
  title: string;
  reviewUrl: string;
  idempotencyKey?: string;
  taskId?: string;
  questionId?: string;
  question?: string;
  message?: string;
}

export function verifyChannelWebhookSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(normalized, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifySlackRequestSignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300
): boolean {
  if (!timestampHeader || !/^\d{1,12}$/.test(timestampHeader) || !signatureHeader || !signingSecret) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || timestamp > nowSeconds + 30 || nowSeconds - timestamp > maxAgeSeconds) return false;
  if (!/^v0=[a-f0-9]{64}$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${timestampHeader}:${rawBody}`, "utf8")
    .digest();
  const supplied = Buffer.from(signatureHeader.slice(3), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function dispatchChannelNotification(
  input: ChannelNotificationInput,
  fetchFn: typeof fetch = fetch
): Promise<{ delivered: boolean; channel: HumanOpsChannel; statusCode?: number }> {
  const idempotencyKey = input.idempotencyKey ?? `${input.projectId}:${input.proposalId}:${input.channel}`;
  const target = input.questionId
    ? `Pergunta '${input.questionId}' da tarefa '${input.taskId}' (${input.projectId}): ${input.question ?? input.title} — Responder em: ${input.reviewUrl}`
    : `Proposta '${input.proposalId}' (${input.projectId}): ${input.title} — Revisar em: ${input.reviewUrl}`;
  const text = input.message ?? `[Noema HumanOps] ${target}`;
  const slackValue = JSON.stringify({ projectId: input.projectId, proposalId: input.proposalId, proposalVersion: input.proposalVersion });
  const hasProposalVersion = Number.isInteger(input.proposalVersion) && input.proposalVersion! > 0;
  const actionChoices = hasProposalVersion
    ? [
        { id: "noema_approve", decision: "approve", label: "Aprovar" },
        { id: "noema_reject", decision: "reject", label: "Rejeitar" },
        { id: "noema_request_changes", decision: "request_changes", label: "Solicitar alterações" }
      ]
    : [];
  const body =
    input.channel === "slack"
      ? {
          text,
          ...(hasProposalVersion
            ? { blocks: [
                { type: "section", text: { type: "mrkdwn", text } },
                { type: "actions", elements: [
                  { type: "button", action_id: "noema_approve", text: { type: "plain_text", text: "Aprovar" }, style: "primary", value: slackValue },
                  { type: "button", action_id: "noema_reject", text: { type: "plain_text", text: "Rejeitar" }, style: "danger", value: slackValue },
                  { type: "button", action_id: "noema_request_changes", text: { type: "plain_text", text: "Solicitar alterações" }, value: slackValue }
                ] }
              ] }
            : {})
        }
      : input.channel === "teams"
        ? {
            "@type": "MessageCard",
            summary: input.title,
            text,
            ...(hasProposalVersion
              ? {
                  potentialAction: actionChoices.map((choice) => ({
                    "@type": "HttpPOST",
                    name: choice.label,
                    body: JSON.stringify({
                      action: choice.id,
                      decision: choice.decision,
                      projectId: input.projectId,
                      proposalId: input.proposalId,
                      proposalVersion: input.proposalVersion
                    })
                  }))
                }
              : {})
          }
        : {
            projectId: input.projectId,
            ...(input.questionId ? { taskId: input.taskId, questionId: input.questionId, question: input.question } : { proposalId: input.proposalId, proposalVersion: input.proposalVersion }),
            title: input.title,
            reviewUrl: input.reviewUrl,
            message: text,
            idempotencyKey,
            ...(hasProposalVersion
              ? {
                  actions: actionChoices.map((choice) => ({
                    action: choice.id,
                    decision: choice.decision,
                    label: choice.label,
                    payload: {
                      projectId: input.projectId,
                      proposalId: input.proposalId,
                      proposalVersion: input.proposalVersion
                    }
                  }))
                }
              : {})
          };

  const res = await fetchFn(input.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-noema-idempotency-key": idempotencyKey
    },
    body: JSON.stringify(body)
  });
  return { delivered: res.ok, channel: input.channel, statusCode: res.status };
}

