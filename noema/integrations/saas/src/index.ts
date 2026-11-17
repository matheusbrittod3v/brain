import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { KnowledgeItem } from "@noema/core";

export type SaasProvider =
  | "jira"
  | "linear"
  | "clickup"
  | "github-projects"
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
  | "teams"
  | "postgresql"
  | "supabase"
  | "mysql"
  | "aws"
  | "gcp"
  | "azure";

const PROVIDER_DEFAULTS: Record<SaasProvider, { domainId: number; type: KnowledgeItem["type"] }> = {
  jira: { domainId: 6, type: "task" },
  linear: { domainId: 6, type: "task" },
  clickup: { domainId: 6, type: "task" },
  "github-projects": { domainId: 6, type: "task" },
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
  bitbucket: { domainId: 4, type: "integration" },
  postgresql: { domainId: 4, type: "integration" },
  supabase: { domainId: 4, type: "integration" },
  mysql: { domainId: 4, type: "integration" },
  aws: { domainId: 8, type: "integration" },
  gcp: { domainId: 8, type: "integration" },
  azure: { domainId: 8, type: "integration" }
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
            type: "message",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.4",
                  body: [
                    { type: "TextBlock", text: input.title, weight: "Bolder", size: "Medium", wrap: true },
                    { type: "TextBlock", text, wrap: true },
                    {
                      type: "FactSet",
                      facts: [
                        { title: "Projeto", value: input.projectId },
                        { title: "Proposta", value: input.proposalId },
                        ...(hasProposalVersion ? [{ title: "Versão", value: String(input.proposalVersion) }] : [])
                      ]
                    }
                  ],
                  actions: [
                    { type: "Action.OpenUrl", title: "Abrir no Command Center", url: input.reviewUrl },
                    ...(hasProposalVersion
                      ? actionChoices.map((choice) => ({
                          type: "Action.Execute",
                          title: choice.label,
                          verb: choice.id,
                          data: {
                            action: choice.id,
                            decision: choice.decision,
                            projectId: input.projectId,
                            proposalId: input.proposalId,
                            proposalVersion: input.proposalVersion
                          }
                        }))
                      : [])
                  ]
                }
              }
            ]
          }
        : input.channel === "jira"
          ? {
              body: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text }]
                  },
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: `Revisar no Noema: ${input.reviewUrl}`,
                        marks: [{ type: "link", attrs: { href: input.reviewUrl } }]
                      }
                    ]
                  }
                ]
              },
              properties: [
                {
                  key: "noema.humanops",
                  value: {
                    projectId: input.projectId,
                    proposalId: input.proposalId,
                    proposalVersion: input.proposalVersion,
                    idempotencyKey,
                    actions: actionChoices.map((choice) => ({
                      action: choice.id,
                      decision: choice.decision,
                      label: choice.label
                    }))
                  }
                }
              ]
            }
          : input.channel === "clickup"
            ? {
                comment_text: `${text}\n\n[Abrir no Command Center](${input.reviewUrl})`,
                notify_all: true,
                noemaHumanOps: {
                  projectId: input.projectId,
                  proposalId: input.proposalId,
                  proposalVersion: input.proposalVersion,
                  idempotencyKey,
                  actions: actionChoices.map((choice) => ({
                    action: choice.id,
                    decision: choice.decision,
                    label: choice.label
                  }))
                }
              }
            : {
                subject: `[Noema HumanOps] ${input.title}`,
                text: `${text}\n\nRevisar: ${input.reviewUrl}`,
                html: `<p>${text.replace(/</g, "&lt;")}</p><p><a href="${input.reviewUrl}">Abrir no Command Center</a></p>`,
                headers: {
                  "X-Noema-Idempotency-Key": idempotencyKey
                },
                actionLinks: actionChoices.map((choice) => ({
                  action: choice.id,
                  decision: choice.decision,
                  label: choice.label,
                  url: `${input.reviewUrl}?decision=${choice.decision}`
                })),
                metadata: {
                  projectId: input.projectId,
                  proposalId: input.proposalId,
                  proposalVersion: input.proposalVersion
                }
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

export interface NormalizedChannelAction {
  decision: "approve" | "reject" | "request_changes";
  projectId: string;
  proposalId: string;
  proposalVersion: number;
  externalUserId: string;
  externalEventId: string;
  comment?: string;
}

const CHANNEL_ACTION_MAP: Record<string, "approve" | "reject" | "request_changes"> = {
  noema_approve: "approve",
  approve: "approve",
  noema_reject: "reject",
  reject: "reject",
  noema_request_changes: "request_changes",
  request_changes: "request_changes"
};

/** Normalizes native Teams Adaptive Card, Jira ADF, ClickUp, and Email webhook payloads into a HumanOps decision. */
export function parseChannelActionPayload(
  channel: Exclude<HumanOpsChannel, "slack">,
  body: Record<string, unknown>
): NormalizedChannelAction | undefined {
  const asRec = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

  let rawAction = typeof body.action === "string" ? body.action : undefined;
  let rawDecision = typeof body.decision === "string" ? body.decision : undefined;
  let projectId = typeof body.projectId === "string" ? body.projectId : undefined;
  let proposalId = typeof body.proposalId === "string" ? body.proposalId : undefined;
  let proposalVersion = typeof body.proposalVersion === "number" ? body.proposalVersion : undefined;
  let externalUserId = typeof body.externalUserId === "string" ? body.externalUserId : undefined;
  let externalEventId = typeof body.externalEventId === "string" ? body.externalEventId : undefined;
  let comment = typeof body.comment === "string" ? body.comment : undefined;

  if (channel === "teams") {
    const actionObj = asRec(body.action);
    const data = asRec(actionObj?.data) ?? asRec(body.value);
    const from = asRec(body.from);
    rawAction = rawAction ?? (typeof actionObj?.verb === "string" ? actionObj.verb : typeof data?.action === "string" ? data.action : undefined);
    rawDecision = rawDecision ?? (typeof data?.decision === "string" ? data.decision : undefined);
    projectId = projectId ?? (typeof data?.projectId === "string" ? data.projectId : undefined);
    proposalId = proposalId ?? (typeof data?.proposalId === "string" ? data.proposalId : undefined);
    proposalVersion = proposalVersion ?? (typeof data?.proposalVersion === "number" ? data.proposalVersion : undefined);
    externalUserId = externalUserId ?? (typeof from?.id === "string" ? from.id : undefined);
    externalEventId = externalEventId ?? (typeof body.id === "string" ? body.id : undefined);
  } else if (channel === "jira") {
    const user = asRec(body.user);
    const issue = asRec(body.issue);
    const props = asRec(issue?.properties);
    const noemaProp = asRec(props?.["noema.humanops"]);
    const commentObj = asRec(body.comment);
    projectId = projectId ?? (typeof noemaProp?.projectId === "string" ? noemaProp.projectId : undefined);
    proposalId = proposalId ?? (typeof noemaProp?.proposalId === "string" ? noemaProp.proposalId : undefined);
    proposalVersion = proposalVersion ?? (typeof noemaProp?.proposalVersion === "number" ? noemaProp.proposalVersion : undefined);
    externalUserId = externalUserId ?? (typeof user?.accountId === "string" ? user.accountId : undefined);
    externalEventId = externalEventId ?? (typeof body.webhookEvent === "string" && typeof body.timestamp === "number" ? `${body.webhookEvent}:${body.timestamp}` : undefined);
    comment = comment ?? (typeof commentObj?.body === "string" ? commentObj.body : undefined);
  } else if (channel === "clickup") {
    const user = asRec(body.user);
    const meta = asRec(body.noemaHumanOps) ?? asRec(body.data);
    projectId = projectId ?? (typeof meta?.projectId === "string" ? meta.projectId : undefined);
    proposalId = proposalId ?? (typeof meta?.proposalId === "string" ? meta.proposalId : undefined);
    proposalVersion = proposalVersion ?? (typeof meta?.proposalVersion === "number" ? meta.proposalVersion : undefined);
    externalUserId = externalUserId ?? (user?.id !== undefined ? String(user.id) : undefined);
    externalEventId = externalEventId ?? (typeof body.webhook_id === "string" ? `${body.webhook_id}:${String(body.event ?? "action")}` : undefined);
  } else if (channel === "email") {
    const meta = asRec(body.metadata);
    projectId = projectId ?? (typeof meta?.projectId === "string" ? meta.projectId : undefined);
    proposalId = proposalId ?? (typeof meta?.proposalId === "string" ? meta.proposalId : undefined);
    proposalVersion = proposalVersion ?? (typeof meta?.proposalVersion === "number" ? meta.proposalVersion : undefined);
    externalUserId = externalUserId ?? (typeof body.recipient === "string" ? body.recipient : undefined);
    externalEventId = externalEventId ?? (typeof body.messageId === "string" ? body.messageId : undefined);
  }

  const decision = (rawDecision ? CHANNEL_ACTION_MAP[rawDecision] : undefined) ?? (rawAction ? CHANNEL_ACTION_MAP[rawAction] : undefined);
  if (!decision || !projectId || !proposalId || !Number.isInteger(proposalVersion) || Number(proposalVersion) < 1 || !externalUserId || !externalEventId) {
    return undefined;
  }
  return {
    decision,
    projectId,
    proposalId,
    proposalVersion: Number(proposalVersion),
    externalUserId,
    externalEventId,
    ...(comment ? { comment } : {})
  };
}

