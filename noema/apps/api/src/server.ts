import Fastify from "fastify";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import PgBoss from "pg-boss";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateRequest, assertPolicyAccess, assertProjectAccess, canApproveDomain, evaluateOpaPolicy, type AuthContext } from "@noema/auth";
import { BrainError, paginateCursor, type KnowledgeItem } from "@noema/core";
import { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import { HybridRetrievalEngine, PostgresRetrievalEngine, ValkeyRetrievalCache, type AsyncRetrievalEngine, type SearchQuery } from "@noema/retrieval";
import { ContextEngine, type IntentType } from "@noema/context-engine";
import { HandoffStore } from "@noema/agent-handoff";
import { BrainRunnerQueue } from "@noema/agent-runner";
import { ApprovalQueue, PostgresApprovalQueue, type ApprovalDecision } from "@noema/approval-engine";
import { cancelRunnerSchedule, createNoemaMcpServer, createRunnerSchedule, listRunnerSchedules } from "@noema/mcp-server";
import { TemporalKnowledgeEngine, PgTemporalKnowledgeRepository } from "@noema/temporal-knowledge";
import { createDatabaseClient, PgOperationalRepository } from "@noema/database";
import { findChangedWorkspaceSources, hashWorkspaceSources } from "@noema/workspace-detection";
import { initTelemetry, shutdownTelemetry, startSpan, type SpanHandle } from "@noema/observability";
import { enqueueEmbedJob, fetchOllamaEmbedding, probeOllamaEmbeddingProvider, type OllamaEmbeddingProviderStatus } from "@noema/worker";
import { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import { buildBusinessRuleTestCoverageMatrix, buildTechRadar, computeProjectHealthReport } from "@noema/enterprise-views";
import { analyzeDistributedImpact } from "@noema/impact-analysis";
import { planAutonomousTasks } from "@noema/task-engine";
import { orchestrateLivingDocDrafts } from "@noema/workflow-orchestrator";
import { defaultNotificationPreferences, nextNotificationWindow, normalizeNotificationPreferences, notificationDigestGroupKey, notificationPreferenceAllows, type NotificationCategory, type NotificationPreferences } from "./notification-preferences.js";
import {
  createAppPostgresClient,
  createPostgresAuditLogger,
  type AppPostgresClient,
  type AuditLogger,
  type RlsSessionContext
} from "@noema/audit-engine";
import {
  parseKnowledgeFile,
  PostgresKnowledgeRepository,
  privacyEraseSubject,
  type SystemKnowledgeSqlClient
} from "@noema/knowledge";
import { PostgresMemoryManager } from "@noema/memory";
import { scanForSecrets, type SecretScanResult } from "@noema/ingestion";
import { extractCodeAnchors } from "@noema/code-intelligence";
import {
  createBranchAndCommitFiles,
  createGitHubPullRequest,
  parseGitHubPushEvent,
  verifyGitHubSignature
} from "@noema/connector-github";
import {
  dispatchChannelNotification,
  handleSaasWebhook,
  parseChannelActionPayload,
  verifyChannelWebhookSignature,
  verifySlackRequestSignature,
  type HumanOpsChannel,
  type SaasProvider
} from "@noema/connector-saas";

function assertSecretScanClean(scan: SecretScanResult, detectedMessage: string): void {
  if (scan.engine === "unavailable") {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Gitleaks indisponível; a gravação foi bloqueada.", 503);
  }
  if (!scan.clean) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", `${detectedMessage}: ${scan.findings.join(", ")}`, 422);
  }
}

export async function redactPiiWithAiWorker(
  text: string,
  aiWorkerUrl = process.env.AI_WORKER_URL,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  if (!aiWorkerUrl) return text;
  let res: Response;
  try {
    res = await fetchFn(`${aiWorkerUrl.replace(/\/$/, "")}/redact-pii`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "AI Worker indisponível; conteúdo não foi persistido porque a sanitização PII configurada não pôde ser concluída.", 503);
  }
  if (!res.ok) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `PII redaction failed: HTTP ${res.status}`, 503);
  }
  let data: { redacted_text?: string };
  try { data = await res.json() as { redacted_text?: string }; }
  catch { throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "PII redaction response is invalid JSON", 502); }
  if (typeof data.redacted_text !== "string") {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "PII redaction response is missing redacted_text", 502);
  }
  return data.redacted_text;
}

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BASE64_CHARS = 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".csv"]);

async function parseDocumentWithAiWorker(fileName: string, contentBase64: string): Promise<{ markdown: string; engine: "docling" | "markitdown" }> {
  const aiWorkerUrl = process.env.AI_WORKER_URL;
  if (!aiWorkerUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Docling requer AI_WORKER_URL configurado.", 503);
  let response: Response;
  try {
    response = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/parse-document`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_name: fileName, content_base64: contentBase64 }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Docling indisponível; documento não foi persistido.", 503);
  }
  if (response.status === 503) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Docling indisponível; documento não foi persistido.", 503);
  if (!response.ok) throw new BrainError("BRAIN_ERR_INVALID_INPUT", `Docling rejeitou o documento (HTTP ${response.status}).`, 422);
  let data: { markdown?: unknown; engine?: unknown };
  try { data = await response.json() as { markdown?: unknown; engine?: unknown }; }
  catch { throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Resposta do Docling inválida.", 502); }
  if ((data.engine !== "docling" && data.engine !== "markitdown") || typeof data.markdown !== "string" || !data.markdown.trim()) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Resposta do Docling não contém Markdown válido.", 502);
  }
  if (Buffer.byteLength(data.markdown, "utf8") > 8 * 1024 * 1024) {
    throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Documento convertido excede o limite de 8 MiB de Markdown.", 422);
  }
  return { markdown: data.markdown, engine: data.engine };
}

async function rerankWithAiWorker<T extends { id: string; title: string; content: string }>(
  query: string,
  items: T[],
  aiWorkerUrl = process.env.AI_WORKER_URL
): Promise<T[]> {
  if (!aiWorkerUrl || items.length <= 1) return items;
  try {
    const res = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        documents: items.map((item) => ({ id: item.id, text: `${item.title}\n${item.content}` }))
      })
    });
    if (!res.ok) return items;
    const data = (await res.json()) as { results?: Array<{ id: string; score?: number }>; ranked_ids?: string[] };
    const orderedIds = data.ranked_ids ?? data.results?.map((r) => r.id);
    if (!orderedIds || orderedIds.length === 0) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    const reranked: T[] = [];
    for (const id of orderedIds) {
      const found = byId.get(id);
      if (found) {
        reranked.push(found);
        byId.delete(id);
      }
    }
    for (const remaining of byId.values()) {
      reranked.push(remaining);
    }
    return reranked;
  } catch {
    return items;
  }
}

function mapExternalHumanActor(
  serviceContext: AuthContext,
  provider: string,
  externalUserId: string,
  projectId: string,
  accessPolicyId: string,
  actorType: "human" | "system" = "human"
): AuthContext {
  const raw = process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
  if (!raw) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Mapeamento de identidade externa não está configurado.", 401);
  }
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "NOEMA_EXTERNAL_ACTOR_MAP_JSON contém JSON inválido.", 401);
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const providerMap = isRecord(config) ? config[provider] : undefined;
  const entry = (isRecord(providerMap) ? providerMap[externalUserId] : undefined) as {
    actorId?: unknown;
    tenantId?: unknown;
    roles?: unknown;
    projectIds?: unknown;
    policyIds?: unknown;
  } | undefined;
  const stringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
  if (
    !entry ||
    typeof entry.actorId !== "string" ||
    entry.actorId.length === 0 ||
    entry.tenantId !== serviceContext.tenantId ||
    !stringArray(entry.roles) ||
    !stringArray(entry.projectIds) ||
    !stringArray(entry.policyIds) ||
    !entry.projectIds.includes(projectId) ||
    !entry.policyIds.includes(accessPolicyId) ||
    !serviceContext.allowedProjects.includes(projectId)
  ) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Identidade externa não mapeada para este tenant, projeto e política.", 403);
  }
  return {
    ...serviceContext,
    actorId: entry.actorId,
    actorType,
    roles: entry.roles,
    allowedProjects: [projectId],
    allowedPolicies: entry.policyIds
  };
}

async function enqueueRemoteGitIngestJob(payload: {
  tenantId: string;
  projectId: string;
  accessPolicyId: string;
  owner: string;
  repo: string;
  ref: string;
  branch?: string;
  beforeCommitSha?: string;
}): Promise<string | null> {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("noema.ingest-git");
  const jobId = await boss.send("noema.ingest-git", payload);
  await boss.stop();
  return jobId;
}

async function enqueueSaasIngestJob(payload: {
  tenantId: string; projectId: string; accessPolicyId: string; provider: SaasProvider; connectionId: string; model?: string;
}): Promise<string | null> {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("noema.ingest-saas");
  const jobId = await boss.send("noema.ingest-saas", payload);
  await boss.stop();
  return jobId;
}

function resolveGitHubRepoMapping(fullName: string): { tenantId: string; projectId: string; accessPolicyId: string } | undefined {
  const raw = process.env.NOEMA_GITHUB_REPO_MAP_JSON;
  if (!raw) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON deve ser um objeto repo→escopo.", 503);
  }
  const normalized = fullName.toLowerCase();
  const entry = Object.entries(config as Record<string, unknown>).find(([repo]) => repo.toLowerCase() === normalized)?.[1];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const mapping = entry as Record<string, unknown>;
  if ([mapping.tenantId, mapping.projectId, mapping.accessPolicyId].some((value) => typeof value !== "string" || !value.trim())) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `Mapeamento GitHub inválido para ${fullName}.`, 503);
  }
  return {
    tenantId: mapping.tenantId as string,
    projectId: mapping.projectId as string,
    accessPolicyId: mapping.accessPolicyId as string
  };
}

function configuredGitHubRepositories(tenantId: string, projectId: string): string[] {
  const raw = process.env.NOEMA_GITHUB_REPO_MAP_JSON;
  if (!raw) return [];
  let config: unknown;
  try { config = JSON.parse(raw); }
  catch { throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON deve ser um objeto repo→escopo.", 503);
  }
  return Object.entries(config as Record<string, unknown>).flatMap(([repository, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const mapping = value as Record<string, unknown>;
    return mapping.tenantId === tenantId && mapping.projectId === projectId ? [repository.toLowerCase()] : [];
  });
}

async function enqueueApprovalReminders(request: { tenantId: string; projectId: string; proposalId: string; item: { accessPolicyId: string }; dueAt: string }, databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) return;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("noema.approval-reminder");
  const dueAt = new Date(request.dueAt);
  const leadMs = Number(process.env.NOEMA_APPROVAL_REMINDER_LEAD_HOURS ?? 24) * 3_600_000;
  const reminderAt = new Date(Math.max(Date.now(), dueAt.getTime() - leadMs));
  const payload = { tenantId: request.tenantId, projectId: request.projectId, proposalId: request.proposalId, accessPolicyId: request.item.accessPolicyId, dueAt: request.dueAt };
  await boss.send("noema.approval-reminder", { ...payload, eventType: "reminder" }, { startAfter: reminderAt, singletonKey: `${request.tenantId}:${request.projectId}:${request.proposalId}:reminder:${request.dueAt}` });
  await boss.send("noema.approval-reminder", { ...payload, eventType: "escalation" }, { startAfter: dueAt, singletonKey: `${request.tenantId}:${request.projectId}:${request.proposalId}:escalation:${request.dueAt}` });
  await boss.stop();
}

interface NotificationDigestPayload {
  tenantId: string; projectId: string; actorId: string; accessPolicyId: string;
  channel: HumanOpsChannel; category: NotificationCategory; scheduledAt: string; groupKey: string;
}

async function enqueueNotificationDigest(payload: NotificationDigestPayload, databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_SYSTEM_URL or DATABASE_URL is required for notification digests.");
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("noema.notification-digest");
  await boss.send("noema.notification-digest", payload, {
    startAfter: new Date(payload.scheduledAt), singletonKey: payload.groupKey
  });
  await boss.stop();
}

function configuredProjectScope(): string[] {
  return [...new Set((process.env.NOEMA_ALLOWED_PROJECTS ?? "")
    .split(",")
    .map((projectId) => projectId.trim())
    .filter(Boolean))];
}

function configuredPolicyScope(): string[] {
  const configured = process.env.NOEMA_ALLOWED_POLICIES;
  if (configured === undefined) return ["public-org", "internal-project", "confidential-business"];
  return [...new Set(configured.split(",").map((policyId) => policyId.trim()).filter(Boolean))];
}

function configuredWorkspaceRoot(projectId: string): string {
  const raw = process.env.NOEMA_PROJECT_WORKSPACE_ROOTS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_PROJECT_WORKSPACE_ROOTS must be valid JSON.", 503);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_PROJECT_WORKSPACE_ROOTS must map project IDs to absolute paths.", 503);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([id, root]) => !id.trim() || typeof root !== "string" || !isAbsolute(root))) {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_PROJECT_WORKSPACE_ROOTS must map project IDs to absolute paths.", 503);
    }
    const projectRoot = (parsed as Record<string, string>)[projectId];
    if (projectRoot) return resolve(projectRoot);
  }
  return resolve(process.env.NOEMA_WORKSPACE_ROOT ?? process.cwd());
}

function normalizeAuditLogRow(row: Record<string, unknown>) {
  const value = (camel: string, snake = camel) => row[camel] ?? row[snake];
  return {
    id: String(value("id") ?? `${String(value("createdAt", "created_at") ?? "")}:${String(value("actorId", "actor_id") ?? "")}:${String(value("targetId", "target_id") ?? "")}`),
    projectId: String(value("projectId", "project_id") ?? ""),
    actorId: String(value("actorId", "actor_id") ?? ""),
    actorType: String(value("actorType", "actor_type") ?? ""),
    accessPolicyId: String(value("accessPolicyId", "access_policy_id") ?? ""),
    action: String(value("action") ?? ""),
    targetType: String(value("targetType", "target_type") ?? ""),
    targetId: value("targetId", "target_id") == null ? null : String(value("targetId", "target_id")),
    createdAt: String(value("createdAt", "created_at") ?? "")
  };
}

export function buildApp(
  expectedApiKey: string | undefined = process.env.NOEMA_LOCAL_API_KEY,
  allowedProjects: readonly string[] = configuredProjectScope(),
  auditLogger?: AuditLogger,
  createAppClient: () => AppPostgresClient = () => createAppPostgresClient(),
  createSystemClient?: () => SystemKnowledgeSqlClient,
  enqueueGitHubJob: typeof enqueueRemoteGitIngestJob = enqueueRemoteGitIngestJob,
  probeEmbeddingProvider: () => Promise<OllamaEmbeddingProviderStatus> = () => probeOllamaEmbeddingProvider(),
  allowedPolicies: readonly string[] = configuredPolicyScope(),
  queryEmbeddingProvider: (query: string) => Promise<number[]> = (query) => {
    const timeoutMs = Math.max(250, Number(process.env.NOEMA_QUERY_EMBEDDING_TIMEOUT_MS ?? 2_500));
    return fetchOllamaEmbedding(
      query,
      process.env.EMBEDDING_MODEL ?? "bge-m3",
      process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      (input, init) => {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        return fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
        });
      }
    );
  }
) {
  const apiKey = expectedApiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("NOEMA_LOCAL_API_KEY is required to start the API.");
  }
  const configuredApiKey = apiKey as string;

  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = String(body);
    (request as typeof request & { noemaRawBody?: string }).noemaRawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const rawBody = String(body);
    (request as typeof request & { noemaRawBody?: string }).noemaRawBody = rawBody;
    const values = Object.fromEntries(new URLSearchParams(rawBody));
    if (typeof values.payload === "string") {
      try {
        values.payload = JSON.parse(values.payload);
      } catch (error) {
        done(error as Error);
        return;
      }
    }
    done(null, values);
  });
  const requestSpans = new WeakMap<object, SpanHandle>();
  const requestStartTimes = new WeakMap<object, number>();
  const latencySamplesMs: number[] = [];
  const recordLatencySample = (ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return;
    latencySamplesMs.push(ms);
    if (latencySamplesMs.length > 500) latencySamplesMs.shift();
  };
  const computeLatencyTelemetry = () => {
    if (latencySamplesMs.length === 0) {
      return { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, maxMs: null };
    }
    const sorted = [...latencySamplesMs].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
    return {
      sampleCount: sorted.length,
      avgMs: Math.round((sum / sorted.length) * 100) / 100,
      p50Ms: Math.round(percentile(0.5) * 100) / 100,
      p95Ms: Math.round(percentile(0.95) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100
    };
  };
  app.addHook("onRequest", async (req) => {
    requestStartTimes.set(req, performance.now());
    requestSpans.set(req, startSpan(`http.${req.method}.${req.routeOptions?.url ?? req.url}`));
  });
  app.addHook("onResponse", async (req, reply) => {
    const start = requestStartTimes.get(req);
    if (start !== undefined) {
      recordLatencySample(performance.now() - start);
    }
    requestSpans.get(req)?.end({
      "http.method": req.method,
      "http.status_code": reply.statusCode
    });
  });
  const allowedCorsOrigin = process.env.NOEMA_CORS_ORIGIN ?? "http://localhost:3000";
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && (allowedCorsOrigin === "*" || origin === allowedCorsOrigin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Mcp-Session-Id");
    }
    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
  const appPostgresClient = auditLogger ? undefined : createAppClient();
  let operationalDatabaseClient: ReturnType<typeof createDatabaseClient> | undefined;
  let ownedSystemSqlClient: ReturnType<typeof createDatabaseClient>["client"] | undefined;
  let systemKnowledgeClient = createSystemClient?.();
  if (!systemKnowledgeClient && process.env.NOEMA_PG_STORES === "1" && process.env.DATABASE_SYSTEM_URL) {
    const systemUrl = process.env.DATABASE_SYSTEM_URL.trim();
    if (new URL(systemUrl).username !== "brain_system") {
      throw new Error("DATABASE_SYSTEM_URL must use the brain_system role for privacy erasure.");
    }
    ownedSystemSqlClient = createDatabaseClient(systemUrl).client;
    systemKnowledgeClient = ownedSystemSqlClient as unknown as SystemKnowledgeSqlClient;
  }
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);
  const handoffs = new HandoffStore();
  const runner = new BrainRunnerQueue();
  const approvals = new ApprovalQueue();
  const temporal = new TemporalKnowledgeEngine();
  const crossService = new CrossServiceContractRegistry();
  const policyEpochByProject = new Map<string, { epoch: number; revocationFingerprint: string | null; allowedPolicyFingerprint: string }>();
  const pgGraph = appPostgresClient && process.env.NOEMA_PG_STORES === "1" ? new PostgresGraphStore(appPostgresClient) : undefined;
  const valkeyUrl = process.env.VALKEY_URL ?? process.env.REDIS_URL;
  const pgRetrieval =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1"
      ? new PostgresRetrievalEngine(appPostgresClient as never, pgGraph, {
          cache: valkeyUrl ? new ValkeyRetrievalCache(valkeyUrl) : undefined
        })
      : undefined;
  const retrievalBase = pgRetrieval ?? retrieval;
  const queryAwareRetrieval: AsyncRetrievalEngine = {
    async search(ctx: AuthContext, query: SearchQuery) {
      let queryEmbedding = query.queryEmbedding;
      if (pgRetrieval && queryEmbedding === undefined && query.query.trim().length > 0) {
        try {
          if ((await probeEmbeddingProvider()).available) {
            queryEmbedding = await queryEmbeddingProvider(query.query);
          }
        } catch {
          // Provider failures degrade to the existing lexical and graph retrieval path.
        }
      }
      return await retrievalBase.search(ctx, {
        ...query,
        ...(queryEmbedding ? { queryEmbedding } : {})
      });
    },
    async getItem(ctx, projectId, itemId) {
      return await retrievalBase.getItem(ctx, projectId, itemId);
    },
    recordHitBoost(projectId, itemId, delta) {
      retrievalBase.recordHitBoost(projectId, itemId, delta);
    },
    invalidateCache(tenantId, projectId) {
      pgRetrieval?.invalidateCache(tenantId, projectId);
    }
  };
  const contextEngine = new ContextEngine(queryAwareRetrieval);
  const pgMemory = appPostgresClient && process.env.NOEMA_PG_STORES === "1"
    ? new PostgresMemoryManager(appPostgresClient as never)
    : undefined;
  const pgKnowledge =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1" ? new PostgresKnowledgeRepository(appPostgresClient as never) : undefined;
  const pgApprovals =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1" ? new PostgresApprovalQueue(appPostgresClient as never) : undefined;
  const opRepo =
    process.env.DATABASE_URL && process.env.NOEMA_PG_STORES === "1"
      ? (() => {
          operationalDatabaseClient = createDatabaseClient(process.env.DATABASE_URL);
          return new PgOperationalRepository(operationalDatabaseClient.db);
        })()
      : undefined;
  const upsertKnowledgeItem = async (ctx: AuthContext, item: KnowledgeItem) => {
    retrieval.upsertItem(item);
    if (pgKnowledge) {
      await pgKnowledge.upsertItem(ctx, item);
      pgRetrieval?.invalidateCache(ctx.tenantId, item.projectId);
    }
  };
  const memoryNotificationPreferences = new Map<string, NotificationPreferences>();
  const integrationFallbackOwners = new Map<string, { fallbackOwner: string; updatedAt: string; updatedBy: string }>();
  const integrationReconnectHistory = new Map<string, { lastReconnectAt: string; status: string; actorId: string }>();
  const departmentQuotas = new Map<string, { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; updatedAt: string }>();
  const accessMembers = new Map<string, { actorId: string; roles: string[]; allowedPolicies: string[]; updatedAt: string; syncedWithKeycloak: boolean }>();
  const temporaryGrants = new Map<string, { grantId: string; tenantId: string; projectId: string; actorId: string; roles: string[]; policyIds: string[]; expiresAt: string; grantedBy: string; createdAt: string }>();
  const customPolicyCatalog = new Map<string, { policyId: string; label: string; description: string; allowedRoles: string[]; updatedAt: string }>();
  const shreddedSubjectKeys = new Set<string>();
  const notificationPreferenceKey = (ctx: AuthContext, projectId: string, policyId: string) => `${ctx.tenantId}:${projectId}:${ctx.actorId}:${policyId}`;
  const accessMemberKey = (ctx: AuthContext, projectId: string, actorId: string) => `${ctx.tenantId}:${projectId}:${actorId}`;
  const customPolicyKey = (ctx: AuthContext, projectId: string, policyId: string) => `${ctx.tenantId}:${projectId}:${policyId}`;
  const getNotificationPreferences = async (ctx: AuthContext, projectId: string, policyId: string) => {
    const saved = opRepo ? await opRepo.getNotificationPreferences(ctx, projectId, policyId) : memoryNotificationPreferences.get(notificationPreferenceKey(ctx, projectId, policyId));
    if (!saved) return defaultNotificationPreferences();
    return normalizeNotificationPreferences(saved);
  };
  const queueNotificationDigest = async (ctx: AuthContext, input: {
    projectId: string; channel: HumanOpsChannel; category: NotificationCategory; targetId: string;
    title: string; frequency: "daily" | "weekly";
  }) => {
    if (!opRepo) throw new BrainError("BRAIN_ERR_CONFLICT", "Digest de notificação requer persistência PostgreSQL.", 503);
    const utcHour = Number(process.env.NOEMA_DIGEST_UTC_HOUR ?? 9);
    const scheduledAt = nextNotificationWindow(input.frequency, new Date(), utcHour);
    const accessPolicyId = "internal-project";
    const groupKey = notificationDigestGroupKey({
      tenantId: ctx.tenantId, projectId: input.projectId, actorId: ctx.actorId,
      accessPolicyId, channel: input.channel, category: input.category, scheduledAt
    });
    const eventKey = `${input.channel}:${input.category}:${input.targetId}:${scheduledAt.toISOString()}`;
    await opRepo.enqueueNotificationDigest(ctx, {
      projectId: input.projectId, accessPolicyId, channel: input.channel,
      category: input.category, eventKey, scheduledAt,
      payload: { targetId: input.targetId, title: input.title }
    });
    const payload: NotificationDigestPayload = {
      tenantId: ctx.tenantId, projectId: input.projectId, actorId: ctx.actorId,
      accessPolicyId, channel: input.channel, category: input.category,
      scheduledAt: scheduledAt.toISOString(), groupKey
    };
    await enqueueNotificationDigest(payload);
    return { delivered: false, queued: true, channel: input.channel, frequency: input.frequency, scheduledAt: scheduledAt.toISOString() };
  };
  const integrationEventMemory = new Map<string, { eventHash: string; response?: Record<string, unknown> }>();
  const testExecutionMemory = new Map<string, { testItemId: string; accessPolicyId: string; commitSha: string; repository?: string; status: "passed" | "failed" | "skipped"; durationMs: number | null; executedAt: string; receivedBy: string }>();
  const githubMainHeadMemory = new Map<string, { repository: string; commitSha: string; accessPolicyId: string }>();
  const pgTemporal =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1"
      ? new PgTemporalKnowledgeRepository(appPostgresClient as never)
      : undefined;
  const pgCrossService =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1"
      ? new PostgresCrossServiceRegistry(appPostgresClient as never)
      : undefined;

  async function enforceOpa(
    ctx: Awaited<ReturnType<typeof authenticateRequest>>,
    resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
  ) {
    const allowed = await evaluateOpaPolicy(ctx, resource);
    if (!allowed) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `OPA negou ação '${resource.action}' em '${resource.projectId}'.`, 403);
    }
  }

  app.addHook("onClose", async () => {
    await appPostgresClient?.close();
    await operationalDatabaseClient?.client.end({ timeout: 5 });
    if (ownedSystemSqlClient) await ownedSystemSqlClient.end({ timeout: 5 });
    await shutdownTelemetry();
  });

  function recordAudit(ctx: Awaited<ReturnType<typeof authenticateRequest>>, event: Parameters<AuditLogger["record"]>[0]) {
    if (auditLogger) return auditLogger.record(event);
    const sessionContext: RlsSessionContext = {
      tenantId: ctx.tenantId,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies
    };
    return createPostgresAuditLogger(appPostgresClient!, sessionContext).record(event);
  }

  async function authenticateProjectRequest(headerValue: string | undefined, projectId: string) {
    const ctx = await authenticateRequest(headerValue, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    assertProjectAccess(ctx, projectId);
    return ctx;
  }

  async function projectVerifiedTests(
    ctx: Awaited<ReturnType<typeof authenticateRequest>>,
    projectId: string,
    items: KnowledgeItem[]
  ) {
    const githubRepositories = configuredGitHubRepositories(ctx.tenantId, projectId);
    const requiresMainHead = githubRepositories.length > 0;
    const mainHeads = pgRetrieval && opRepo
      ? await opRepo.listGitHubMainHeads(ctx, projectId)
      : [...githubMainHeadMemory.entries()]
        .filter(([key]) => key.startsWith(`${ctx.tenantId}:${projectId}:`))
        .map(([, head]) => head);
    const mainHeadByRepository = new Map(mainHeads.map((head) => [head.repository.toLowerCase(), head.commitSha.toLowerCase()]));
    const linkedTestsByRule = new Map<string, string[]>();
    const testItemsById = new Map(items.filter((item) => item.type === "test").map((item) => [item.id, item]));
    for (const rule of items.filter((item) => item.type === "business_rule" && item.status !== "deprecated")) {
      // Include Rule -> CodeSymbol -> Test so explicit symbol mappings count alongside direct @brain-rule anchors.
      const related = await (pgGraph ?? graph).traverseRelated(ctx, { projectId, itemId: rule.id }, 2);
      const testIds = related.filter((hit) => hit.via === "VERIFIED_BY").map((hit) => hit.itemId);
      for (const testId of testIds) {
        if (testItemsById.has(testId)) continue;
        const test = pgKnowledge
          ? await pgKnowledge.getItem(ctx, projectId, testId)
          : retrieval.getItem(ctx, projectId, testId);
        if (test && (test.type === "test" || /\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(test.sourceUri))) testItemsById.set(testId, test);
      }
      const existingTestIds = [...new Set(testIds)].filter((testId) => testItemsById.has(testId));
      if (existingTestIds.length > 0) linkedTestsByRule.set(rule.id, existingTestIds);
    }
    const linkedTestIds = [...new Set([...linkedTestsByRule.values()].flat())];
    const testExecutionResults = pgRetrieval && opRepo
      ? requiresMainHead
        ? mainHeadByRepository.size > 0
          ? await opRepo.listLatestTestExecutionResults(ctx, projectId, linkedTestIds, mainHeadByRepository)
          : []
        : await opRepo.listLatestTestExecutionResults(ctx, projectId, linkedTestIds)
      : [...testExecutionMemory.entries()]
        .filter(([key]) => key.startsWith(`${ctx.tenantId}:${projectId}:`))
        .map(([, value]) => value)
        .filter((result) => !requiresMainHead || Boolean(result.repository && mainHeadByRepository.get(result.repository.toLowerCase()) === result.commitSha.toLowerCase()))
        .sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    const latestByTest = new Map<string, (typeof testExecutionResults)[number]>();
    for (const result of testExecutionResults) if (!latestByTest.has(result.testItemId)) latestByTest.set(result.testItemId, result);
    const latestTestExecutionResults = [...latestByTest.values()];
    const verifiedTests = new Map<string, string[]>();
    for (const [ruleId, testIds] of linkedTestsByRule) {
      const passing = testIds.filter((testId) => {
        const test = testItemsById.get(testId)!;
        const result = latestByTest.get(testId);
        if (result?.status !== "passed") return false;
        const sourceRepository = typeof test.metadata?.sourceRepository === "string" ? test.metadata.sourceRepository.toLowerCase() : undefined;
        if (githubRepositories.length > 1 && !sourceRepository) return false;
        if (sourceRepository && sourceRepository !== result.repository?.toLowerCase()) return false;
        return !/^[a-f0-9]{40,64}$/i.test(test.sourceVersion) || test.sourceVersion.toLowerCase() === result.commitSha.toLowerCase();
      });
      if (passing.length > 0) verifiedTests.set(ruleId, passing);
    }
    return { verifiedTests, linkedTestsByRule, testItemsById, testExecutionResults: latestTestExecutionResults, requireMainHead: requiresMainHead, requireRepositoryAssociation: githubRepositories.length > 1, mainHeadByRepository };
  }

  function projectHealth(items: KnowledgeItem[], verifiedTests: Map<string, string[]>) {
    const health = computeProjectHealthReport(items, []);
    health.untestedRuleIds = health.untestedRuleIds.filter((id) => !verifiedTests.has(id));
    const penalty = health.untestedRuleIds.length * 10 + health.staleItemIds.length * 5 + health.gitVsConnectorConflicts.length * 15;
    health.healthScore = Math.max(0, 100 - penalty);
    return health;
  }

  async function projectModelUsage(ctx: AuthContext, projectId: string) {
    if (!appPostgresClient || !process.env.DATABASE_URL) {
      return { windowDays: 30, modelUsageAvailable: false, calls: 0, byModel: [], providerCostUsd: null, infrastructureCostAvailable: false };
    }
    const rows = await appPostgresClient.withRlsTransaction(
      { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
      async (client) => await client`
        SELECT result_metadata->'modelUsage' AS model_usage
        FROM runner_tasks
        WHERE tenant_id = ${ctx.tenantId}
          AND project_id = ${projectId}
          AND created_at >= now() - interval '30 days'
          AND result_metadata->'modelUsage' IS NOT NULL
      ` as Array<{ model_usage: unknown }>
    );
    const groups = new Map<string, {
      provider: string; model: string; costBasis: string; calls: number;
      inputTokens: number; outputTokens: number; totalTokens: number;
      tokenCalls: number; providerCostUsd: number; knownCostCalls: number;
    }>();
    for (const row of rows) {
      const usage = typeof row.model_usage === "string" ? JSON.parse(row.model_usage) as Record<string, unknown> : row.model_usage as Record<string, unknown>;
      if (!usage || typeof usage !== "object") continue;
      const provider = typeof usage.provider === "string" ? usage.provider : "unknown";
      const model = typeof usage.model === "string" ? usage.model : "unknown";
      const costBasis = typeof usage.costBasis === "string" ? usage.costBasis : "unknown";
      const key = `${provider}:${model}:${costBasis}`;
      const group = groups.get(key) ?? { provider, model, costBasis, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenCalls: 0, providerCostUsd: 0, knownCostCalls: 0 };
      group.calls += 1;
      const input = typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
      const output = typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
      const total = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
      if (input !== null && output !== null && total !== null) {
        group.inputTokens += input; group.outputTokens += output; group.totalTokens += total; group.tokenCalls += 1;
      }
      if (typeof usage.providerCostUsd === "number" && Number.isFinite(usage.providerCostUsd)) {
        group.providerCostUsd += usage.providerCostUsd; group.knownCostCalls += 1;
      }
      groups.set(key, group);
    }
    const byModel = [...groups.values()].map((group) => ({
      provider: group.provider, model: group.model, costBasis: group.costBasis, calls: group.calls,
      inputTokens: group.tokenCalls === group.calls ? group.inputTokens : null,
      outputTokens: group.tokenCalls === group.calls ? group.outputTokens : null,
      totalTokens: group.tokenCalls === group.calls ? group.totalTokens : null,
      providerCostUsd: group.knownCostCalls === group.calls ? group.providerCostUsd : null
    }));
    const allCostsKnown = byModel.every((group) => group.providerCostUsd !== null);
    return {
      windowDays: 30,
      modelUsageAvailable: rows.length > 0,
      calls: rows.length,
      byModel,
      providerCostUsd: allCostsKnown && rows.length > 0 ? byModel.reduce((sum, group) => sum + (group.providerCostUsd ?? 0), 0) : null,
      infrastructureCostAvailable: false
    };
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BrainError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof Error && err.name === "BrainError" && "code" in err && "statusCode" in err) {
      const be = err as { code: string; statusCode: number; message: string };
      return reply.status(be.statusCode).send({ error: be.code, message: be.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: "INTERNAL_ERROR", message });
  });

  app.get("/v1/health", async () => ({ service: "noema-api", status: "ok", version: "0.1.0" }));

  app.get("/v1/auth/me", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects);
    const visibilityScope = ctx.roles.some((r) => ["admin", "appsec", "cto"].includes(r))
      ? "org"
      : ctx.roles.some((r) => ["tech-lead", "po", "reviewer"].includes(r))
        ? "project"
        : "self";
    return {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      roles: ctx.roles,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies,
      visibilityScope
    };
  });

  type DeveloperProfileData = {
    tenantId: string;
    actorId: string;
    preferredPackageManager?: string;
    preferredTestLayout?: string;
    preferredArchitectureStyle?: string;
    codingConventions: string[];
    preferredHarness?: string;
    optInCrossProject: boolean;
    updatedAt: string;
  };
  const developerProfilesMem = new Map<string, DeveloperProfileData>();
  const getDeveloperProfile = async (ctx: AuthContext): Promise<DeveloperProfileData | undefined> => {
    if (opRepo) return opRepo.getDeveloperProfile(ctx);
    return developerProfilesMem.get(`${ctx.tenantId}:${ctx.actorId}`);
  };
  const saveDeveloperProfile = async (
    ctx: AuthContext,
    body: {
      preferredPackageManager?: string;
      preferredTestLayout?: string;
      preferredArchitectureStyle?: string;
      codingConventions?: string[];
      preferredHarness?: string;
      optInCrossProject?: boolean;
    }
  ): Promise<DeveloperProfileData> => {
    if (opRepo) return opRepo.upsertDeveloperProfile(ctx, body);
    const saved: DeveloperProfileData = {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      ...(body.preferredPackageManager ? { preferredPackageManager: body.preferredPackageManager } : {}),
      ...(body.preferredTestLayout ? { preferredTestLayout: body.preferredTestLayout } : {}),
      ...(body.preferredArchitectureStyle ? { preferredArchitectureStyle: body.preferredArchitectureStyle } : {}),
      codingConventions: body.codingConventions ?? [],
      ...(body.preferredHarness ? { preferredHarness: body.preferredHarness } : {}),
      optInCrossProject: body.optInCrossProject ?? true,
      updatedAt: new Date().toISOString()
    };
    developerProfilesMem.set(`${ctx.tenantId}:${ctx.actorId}`, saved);
    return saved;
  };

  app.get("/v1/profile/developer", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const profile = await getDeveloperProfile(ctx);
    return {
      profile: profile ?? {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        codingConventions: [],
        optInCrossProject: true,
        updatedAt: null
      }
    };
  });

  app.put<{
    Body: {
      preferredPackageManager?: string;
      preferredTestLayout?: string;
      preferredArchitectureStyle?: string;
      codingConventions?: string[];
      preferredHarness?: string;
      optInCrossProject?: boolean;
    };
  }>("/v1/profile/developer", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const conventions = (req.body.codingConventions ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (conventions.length > 0) {
      const scan = scanForSecrets(conventions.join("\n"));
      assertSecretScanClean(scan, "Segredo detectado no perfil do desenvolvedor");
    }
    const profile = await saveDeveloperProfile(ctx, {
      preferredPackageManager: req.body.preferredPackageManager?.trim() || undefined,
      preferredTestLayout: req.body.preferredTestLayout?.trim() || undefined,
      preferredArchitectureStyle: req.body.preferredArchitectureStyle?.trim() || undefined,
      codingConventions: conventions,
      preferredHarness: req.body.preferredHarness?.trim() || undefined,
      optInCrossProject: req.body.optInCrossProject ?? true
    });
    return { profile };
  });

  app.delete("/v1/profile/developer", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const deleted = opRepo
      ? await opRepo.deleteDeveloperProfile(ctx)
      : developerProfilesMem.delete(`${ctx.tenantId}:${ctx.actorId}`);
    return { deleted };
  });

  app.post(
    "/v1/projects/:projectId/ingest",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({ filePath: Type.String(), content: Type.String(), commitSha: Type.Optional(Type.String()) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const scan = scanForSecrets(req.body.content, { ignoreFilePath: ".brainignore-secrets" });
      assertSecretScanClean(scan, "Segredo detectado na ingestão");
      const sanitizedContent = await redactPiiWithAiWorker(req.body.content);
      const piiRedacted = sanitizedContent !== req.body.content;
      if (scan.ignoredFindings.length > 0) {
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "brainignore_secrets",
          targetId: req.body.filePath,
          metadata: { ignoredFindings: scan.ignoredFindings }
        });
      }

      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        filePath: req.body.filePath,
        rawContent: sanitizedContent,
        commitSha: req.body.commitSha
      });
      assertPolicyAccess(ctx, item.accessPolicyId);
      await enforceOpa(ctx, {
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        action: "write",
        domainId: item.domainId
      });
      await upsertKnowledgeItem(ctx, item);

      const anchors = extractCodeAnchors(req.body.filePath, sanitizedContent);
      for (const anchor of anchors) {
        const edge = {
          tenantId: ctx.tenantId,
          fromProjectId: req.params.projectId,
          toProjectId: req.params.projectId,
          fromItemId: item.id,
          toItemId: anchor.targetId,
          fromPolicyId: item.accessPolicyId,
          toPolicyId: item.accessPolicyId,
          relationType: anchor.relationType,
          isInferred: false as const,
          confidence: 1.0
        };
        graph.addEdge(edge);
        if (pgGraph) {
          await pgGraph.addEdge(ctx, edge);
        }
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId, projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "knowledge_item", targetId: item.id, metadata: { piiRedacted }
      });

      const warnings: string[] = [];
      if (piiRedacted) warnings.push("Dados pessoais foram sanitizados pelo AI Worker antes da indexação.");
      if (process.env.NOEMA_PG_BOSS === "1" && process.env.DATABASE_URL) {
        const embeddingProvider = await probeEmbeddingProvider();
        if (!embeddingProvider.available) {
          const reason = embeddingProvider.reason === "model_missing"
            ? "o modelo configurado não está instalado"
            : "o provedor não está acessível";
          warnings.push(`Embeddings vetoriais não foram enfileirados: ${reason}; o item permanece disponível para busca textual.`);
        } else {
          try {
            const jobId = await enqueueEmbedJob({
              tenantId: ctx.tenantId,
              projectId: req.params.projectId,
              itemId: item.id,
              sourceVersion: item.sourceVersion,
              accessPolicyId: item.accessPolicyId,
              content: item.content
            });
            if (!jobId) warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
          } catch {
            warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
          }
        }
      } else {
        warnings.push("Embeddings vetoriais não foram enfileirados porque o worker pg-boss não está configurado; o item permanece disponível para busca textual.");
      }

      return { ingested: true, id: item.id, anchorsCount: anchors.length, warnings };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { task: string; intent?: IntentType; includeDomains?: number[]; tokenBudget?: number; explain?: boolean; sessionId?: string; taskId?: string };
  }>(
    "/v1/projects/:projectId/context",
    {
      schema: {
        body: Type.Object({
          task: Type.String(),
          intent: Type.Optional(Type.String()),
          includeDomains: Type.Optional(Type.Array(Type.Number())),
          tokenBudget: Type.Optional(Type.Number()),
          explain: Type.Optional(Type.Boolean()),
          sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          taskId: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const sessionId = req.body.sessionId ?? randomUUID();
      const pack = await contextEngine.buildContextPack(ctx, {
        projectId: req.params.projectId,
        task: req.body.task,
        intent: req.body.intent,
        includeDomains: req.body.includeDomains,
        tokenBudget: req.body.tokenBudget,
        explain: req.body.explain,
        sessionId,
        memories: pgMemory ? await pgMemory.listVisible(ctx, req.params.projectId, sessionId) : []
      });
      const sourceHashes = await hashWorkspaceSources(configuredWorkspaceRoot(req.params.projectId), pack.sources.map((source) => source.sourceUri));
      const hashByUri = new Map(sourceHashes.map((source) => [source.sourceUri, source.sourceHash]));
      const rate = opRepo ? await opRepo.recordContextDelivery(ctx, req.params.projectId, sessionId, pack.sources.map((source) => ({
        itemId: source.id,
        accessPolicyId: source.accessPolicyId,
        sourceUri: source.sourceUri,
        sourceHash: hashByUri.get(source.sourceUri),
        taskId: req.body.taskId
      }))) : { sessionId, hits: 0, itemsSent: pack.sources.length, rate: null };
      const devProfile = await getDeveloperProfile(ctx);
      return {
        ...pack,
        sessionId,
        hitRate: rate,
        ...(devProfile?.optInCrossProject ? { developerProfile: devProfile } : {})
      };
    }
  );

  app.post<{ Params: { projectId: string }; Body: { instruction: string; priority?: "low" | "normal" | "high" } }>(
    "/v1/projects/:projectId/runner/tasks",
    {
      schema: {
        body: Type.Object({ instruction: Type.String(), priority: Type.Optional(Type.String()) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const task = runner.enqueue(ctx, { projectId: req.params.projectId, instruction: req.body.instruction, priority: req.body.priority });
      if (opRepo) {
        await opRepo.saveRunnerTask(ctx, task);
      }
      return task;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/schedules", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
    const schedules = await listRunnerSchedules({ tenantId: ctx.tenantId, projectId: req.params.projectId }, databaseUrl);
    return { schedules };
  });

  app.delete<{ Params: { projectId: string; scheduleId: string } }>(
    "/v1/projects/:projectId/runner/schedules/:scheduleId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
      const cancelled = await cancelRunnerSchedule(
        { tenantId: ctx.tenantId, projectId: req.params.projectId }, req.params.scheduleId, databaseUrl
      );
      if (!cancelled) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Schedule '${req.params.scheduleId}' não encontrado.`, 404);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
        actorId: ctx.actorId, actorType: ctx.actorType, action: "revoke", targetType: "runner_schedule",
        targetId: req.params.scheduleId, metadata: {}
      });
      return { scheduleId: req.params.scheduleId, cancelled: true };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/tasks", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const tasks = opRepo
      ? await opRepo.listRunnerTasks(ctx, req.params.projectId)
      : runner.listTasks(ctx, req.params.projectId);
    const pendingQuestions = opRepo
      ? await opRepo.listPendingRunnerQuestions(ctx, req.params.projectId)
      : runner.listPendingQuestions(ctx, req.params.projectId);
    const questionByTask = new Map(pendingQuestions.map((question) => [question.taskId, question]));
    return {
      tasks: tasks.map((task) => {
        const pendingQuestion = questionByTask.get(task.taskId);
        return pendingQuestion
          ? { ...task, pendingQuestion: { questionId: pendingQuestion.questionId, question: pendingQuestion.question } }
          : task;
      })
    };
  });

  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/cancel",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (opRepo) {
        const cancelled = await opRepo.cancelRunnerTask(ctx, req.params.projectId, req.params.taskId);
        if (!cancelled) {
          throw new BrainError(
            "BRAIN_ERR_CONFLICT",
            `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`,
            409
          );
        }
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "revoke",
          targetType: "runner_task",
          targetId: req.params.taskId,
          metadata: { status: "cancelled" }
        });
        return cancelled;
      }
      const task = runner.getTask(ctx, req.params.taskId);
      if (!task || task.projectId !== req.params.projectId || !["queued", "waiting_human", "escalated"].includes(task.status)) {
        throw new BrainError(
          "BRAIN_ERR_CONFLICT",
          `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`,
          409
        );
      }
      task.status = "cancelled" as typeof task.status;
      task.resultSummary = "Cancelada pelo operador.";
      return task;
    }
  );

  app.post("/v1/projects/:projectId/runner/tasks/:taskId/questions", {
    schema: {
      params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
      body: Type.Object({ question: Type.String({ minLength: 1 }) })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const questionText = req.body.question.trim();
    if (!questionText) throw new BrainError("BRAIN_ERR_CONFLICT", "A pergunta não pode estar vazia.", 400);
    const question = opRepo
      ? await opRepo.createRunnerQuestion(ctx, {
          questionId: randomUUID(),
          projectId: req.params.projectId,
          taskId: req.params.taskId,
          question: questionText,
          accessPolicyId: "internal-project"
        })
      : runner.askQuestion(ctx, req.params.taskId, questionText);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "runner_task_question",
      targetId: question.questionId,
      metadata: { taskId: req.params.taskId }
    });
    return { questionId: question.questionId, taskId: req.params.taskId, question: question.question, status: question.status };
  });

  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/questions",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const questions = opRepo
        ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
        : runner.listQuestions(ctx, req.params.taskId);
      return { questions };
    }
  );

  app.post<{
    Params: { projectId: string; taskId: string; questionId: string };
    Body: { channel: HumanOpsChannel; webhookUrl?: string; reviewUrl?: string };
  }>("/v1/projects/:projectId/runner/tasks/:taskId/questions/:questionId/notify", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const questions = opRepo
      ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
      : runner.listQuestions(ctx, req.params.taskId);
    const question = questions.find((entry) => entry.questionId === req.params.questionId);
    if (!question) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${req.params.questionId}' não encontrada para a tarefa.`, 404);
    if (question.status !== "pending") throw new BrainError("BRAIN_ERR_CONFLICT", "Somente perguntas pendentes podem ser notificadas.", 409);
    const preferences = await getNotificationPreferences(ctx, req.params.projectId, "internal-project");
    if (!notificationPreferenceAllows(preferences, req.body.channel, "runner_question")) {
      return { delivered: false, suppressed: true, channel: req.body.channel, reason: "Canal ou categoria desativada nas preferências pessoais." };
    }
    const envWebhookMap: Record<HumanOpsChannel, string | undefined> = {
      slack: process.env.NOEMA_SLACK_WEBHOOK_URL,
      teams: process.env.NOEMA_TEAMS_WEBHOOK_URL,
      jira: process.env.NOEMA_JIRA_WEBHOOK_URL,
      clickup: process.env.NOEMA_CLICKUP_WEBHOOK_URL,
      email: process.env.NOEMA_EMAIL_WEBHOOK_URL
    };
    const webhookUrl = req.body.webhookUrl ?? envWebhookMap[req.body.channel];
    if (!webhookUrl) return { delivered: false, channel: req.body.channel, reason: `Webhook para canal '${req.body.channel}' não configurado.` };
    const panelUrl = new URL(req.body.reviewUrl ?? `${process.env.NOEMA_CORS_ORIGIN ?? "http://localhost:3000"}`);
    panelUrl.searchParams.set("workspace", "agents");
    panelUrl.searchParams.set("projectId", req.params.projectId);
    if (preferences.frequency !== "immediate") {
      if (!envWebhookMap[req.body.channel]) return { delivered: false, channel: req.body.channel, reason: "Digest exige o webhook do canal configurado no servidor." };
      const queued = await queueNotificationDigest(ctx, {
        projectId: req.params.projectId, channel: req.body.channel, category: "runner_question",
        targetId: question.questionId, title: `Pergunta do Runner: ${question.question}`, frequency: preferences.frequency
      });
      await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project", actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "channel_notification", targetId: question.questionId, metadata: { channel: req.body.channel, queued: true, scheduledAt: queued.scheduledAt } });
      return queued;
    }
    const result = await dispatchChannelNotification({
      channel: req.body.channel, webhookUrl, projectId: req.params.projectId, proposalId: req.params.taskId,
      taskId: req.params.taskId, questionId: question.questionId, question: question.question,
      title: "Pergunta do Brain Runner",
      reviewUrl: panelUrl.toString(),
      idempotencyKey: `${req.params.projectId}:${req.params.taskId}:${question.questionId}:${req.body.channel}`
    });
    await recordAudit(ctx, {
      tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
      actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "channel_notification",
      targetId: question.questionId, metadata: { channel: req.body.channel, delivered: result.delivered, statusCode: result.statusCode }
    });
    return result;
  });

  app.post<{
    Params: { projectId: string };
    Body: { taskId: string; fromAgent: string; repoUrl: string; branch: string; baseCommitSha: string; modifiedFiles: string[]; nextSteps: string[] };
  }>("/v1/projects/:projectId/handoffs", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const created = handoffs.createHandoff(ctx, {
      ...req.body,
      projectId: req.params.projectId,
      workingTreeDirty: false,
      testsExecuted: [],
      decisions: []
    });
    if (opRepo) {
      await opRepo.saveHandoff(ctx, created);
      await opRepo.upsertLease(ctx, req.params.projectId, created.taskId, created.branch);
    }
    return created;
  });

  app.get<{ Params: { projectId: string }; Querystring: { taskId?: string; limit?: number } }>(
    "/v1/projects/:projectId/handoffs",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (opRepo) {
        if (req.query.taskId) {
          const latest = await opRepo.getLatestHandoff(ctx, req.params.projectId, req.query.taskId);
          return { handoffs: latest ? [latest] : [] };
        }
        const items = await opRepo.listHandoffs(ctx, req.params.projectId, Math.min(50, Math.max(1, Number(req.query.limit ?? 20))));
        return { handoffs: items };
      }
      const latest = handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.query.taskId }).handoff;
      return { handoffs: latest ? [latest] : [] };
    }
  );

  app.get<{ Params: { projectId: string }; Querystring: { taskId?: string } }>(
    "/v1/projects/:projectId/handoffs/latest",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (opRepo) {
        const latest = await opRepo.getLatestHandoff(ctx, req.params.projectId, req.query.taskId);
        return { handoff: latest ?? null, warnings: latest ? [] : ["Nenhum handoff encontrado."] };
      }
      return handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.query.taskId });
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      harness: string;
      event: "session_start" | "tool_use" | "session_end" | "pre_compact";
      sessionId: string;
      summary?: string;
      modifiedFiles?: string[];
      branch?: string;
      commitSha?: string;
      usedItemIds?: string[];
      taskId?: string;
    };
  }>("/v1/projects/:projectId/hooks/lifecycle", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const harness = req.body.harness?.trim() || "unknown";
    const summary = req.body.summary?.trim() ?? "";
    if (summary) {
      const scan = scanForSecrets(summary);
      assertSecretScanClean(scan, "Segredo detectado no payload de lifecycle hook");
    }
    const warnings: string[] = [];
    const memoryLayer = req.body.event === "session_end" || req.body.event === "pre_compact" ? "episodic" : "working";
    const memoryContent = summary || `[${harness}] ${req.body.event} (session=${req.body.sessionId})`;
    if (opRepo) {
      await opRepo.appendMemory(ctx, {
        projectId: req.params.projectId,
        sessionId: req.body.sessionId,
        layer: memoryLayer,
        content: memoryContent,
        accessPolicyId: "internal-project"
      });
    }
    let citationsRecorded = 0;
    if (opRepo && req.body.usedItemIds && req.body.usedItemIds.length > 0) {
      try {
        await opRepo.recordContextEvidence(ctx, req.params.projectId, req.body.sessionId, req.body.usedItemIds, "citation");
        citationsRecorded = req.body.usedItemIds.length;
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : "Não foi possível registrar citação automática.");
      }
    }
    let handoffCreated: { handoffId: string; taskId: string } | undefined;
    if (req.body.event === "session_end" && (summary || (req.body.modifiedFiles?.length ?? 0) > 0)) {
      const taskId = req.body.taskId?.trim() || `HOOK-${req.body.sessionId.slice(0, 12)}`;
      const created = handoffs.createHandoff(ctx, {
        projectId: req.params.projectId,
        taskId,
        fromAgent: harness,
        repoUrl: "",
        branch: req.body.branch?.trim() || "main",
        baseCommitSha: req.body.commitSha?.trim() || "HEAD",
        workingTreeDirty: (req.body.modifiedFiles?.length ?? 0) > 0,
        modifiedFiles: req.body.modifiedFiles ?? [],
        testsExecuted: [],
        decisions: summary ? [summary] : [],
        nextSteps: summary ? [`Retomar sessão (${harness}): ${summary.slice(0, 160)}`] : ["Retomar sessão anterior"]
      });
      if (opRepo) {
        await opRepo.saveHandoff(ctx, created);
        await opRepo.upsertLease(ctx, req.params.projectId, created.taskId, created.branch);
      }
      handoffCreated = { handoffId: created.handoffId, taskId: created.taskId };
    }
    const developerProfile = req.body.event === "session_start" ? await getDeveloperProfile(ctx) : undefined;
    const latestHandoff = req.body.event === "session_start"
      ? (opRepo
        ? await opRepo.getLatestHandoff(ctx, req.params.projectId, req.body.taskId)
        : handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.body.taskId }).handoff)
      : undefined;
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "lifecycle_hook",
      targetId: `${harness}:${req.body.event}`,
      metadata: { sessionId: req.body.sessionId, citationsRecorded, handoffId: handoffCreated?.handoffId }
    });
    return {
      ok: true,
      harness,
      event: req.body.event,
      sessionId: req.body.sessionId,
      memoryLayer,
      citationsRecorded,
      ...(handoffCreated ? { handoffCreated } : {}),
      ...(developerProfile?.optInCrossProject ? { developerProfile } : {}),
      ...(latestHandoff ? { latestHandoff } : {}),
      warnings
    };
  });

  app.post(
    "/v1/projects/:projectId/ingest-document",
    {
      bodyLimit: 24 * 1024 * 1024,
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          fileName: Type.String({ minLength: 1, maxLength: 255 }),
          contentBase64: Type.String({ minLength: 1, maxLength: MAX_DOCUMENT_BASE64_CHARS }),
          accessPolicyId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 }))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const { fileName, contentBase64 } = req.body;
      if (fileName !== fileName.trim() || /[/\\\0\r\n]/.test(fileName)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "fileName deve ser apenas um nome de arquivo, sem caminho.", 422);
      }
      const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
      if (!DOCUMENT_EXTENSIONS.has(extension)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Formato não suportado. Use PDF, DOCX, PPTX, XLSX, HTML ou CSV.", 422);
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "contentBase64 inválido.", 422);
      }
      const sourceBytes = Buffer.from(contentBase64, "base64");
      if (sourceBytes.length === 0 || sourceBytes.length > MAX_DOCUMENT_BYTES || sourceBytes.toString("base64") !== contentBase64) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Documento vazio ou acima do limite de 16 MiB.", 422);
      }
      const policy = req.body.accessPolicyId ?? "internal-project";
      assertPolicyAccess(ctx, policy);

      const parsedDocument = await parseDocumentWithAiWorker(fileName, contentBase64);
      const extractedMarkdown = parsedDocument.markdown;
      const scan = scanForSecrets(extractedMarkdown, { ignoreFilePath: ".brainignore-secrets" });
      assertSecretScanClean(scan, "Segredo detectado no documento extraído");
      const sanitizedMarkdown = await redactPiiWithAiWorker(extractedMarkdown);
      const piiRedacted = sanitizedMarkdown !== extractedMarkdown;
      const normalizedName = fileName.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+/, "");
      const sourceUri = `.brain/imported-documents/${normalizedName}.md`;
      const rawContent = [
        "---", `id: ${JSON.stringify(sourceUri)}`, `title: ${JSON.stringify(fileName)}`,
        "type: document", "status: draft", "trust_level: untrusted", `access_policy: ${JSON.stringify(policy)}`, "---", "", sanitizedMarkdown
      ].join("\n");
      const item = parseKnowledgeFile({ tenantId: ctx.tenantId, projectId: req.params.projectId, filePath: sourceUri, rawContent });
      item.sourceOrigin = "external_reference";
      item.sourceKind = "api";
      item.trustLevel = "untrusted";
      item.metadata = { ...item.metadata, source: "document_upload", originalFileName: fileName, extractionEngine: parsedDocument.engine };
      assertPolicyAccess(ctx, item.accessPolicyId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
      await upsertKnowledgeItem(ctx, item);
      if (scan.ignoredFindings.length > 0) {
        await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: item.accessPolicyId,
          actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "brainignore_secrets", targetId: sourceUri,
          metadata: { ignoredFindings: scan.ignoredFindings } });
      }
      await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "knowledge_item", targetId: item.id,
        metadata: { source: "document_ingest", originalFileName: fileName, piiRedacted, extractionEngine: parsedDocument.engine } });

      const warnings: string[] = [];
      if (piiRedacted) warnings.push("Dados pessoais foram sanitizados pelo AI Worker antes da indexação.");
      if (process.env.NOEMA_PG_BOSS === "1" && process.env.DATABASE_URL) {
        const embeddingProvider = await probeEmbeddingProvider();
        if (embeddingProvider.available) {
          try {
            const jobId = await enqueueEmbedJob({ tenantId: item.tenantId, projectId: item.projectId, itemId: item.id,
              sourceVersion: item.sourceVersion, accessPolicyId: item.accessPolicyId, content: item.content });
            if (!jobId) warnings.push("Embeddings não foram enfileirados; o item permanece disponível para busca textual.");
          } catch { warnings.push("Embeddings não foram enfileirados; o item permanece disponível para busca textual."); }
        } else warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
      } else warnings.push("Embeddings vetoriais não foram enfileirados porque o worker pg-boss não está configurado; o item permanece disponível para busca textual.");
      return { item, piiRedacted, warnings };
    }
  );

  // Edge Sync: Pull incremental filtrado por projeto e política
  app.post(
    "/v1/sync/pull",
    {
      schema: {
        body: Type.Object({
          projectId: Type.String(),
          sinceSeq: Type.Optional(Type.Number()),
          policyEpoch: Type.Optional(Type.Number()),
          snapshotSeq: Type.Optional(Type.Number()),
          snapshotCursor: Type.Optional(Type.String()),
          pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          knownPolicies: Type.Optional(Type.Array(Type.String()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
      const known = new Set(req.body.knownPolicies ?? []);
      const allowed = new Set(ctx.allowedPolicies);
      const revokedPolicies = [...known].filter((p) => !allowed.has(p));

      const epochKey = `${ctx.tenantId}:${req.body.projectId}:${ctx.actorId}`;
      let nextEpoch: number;
      if (opRepo) {
        nextEpoch = await opRepo.updatePolicyEpoch(ctx, req.body.projectId, revokedPolicies);
      } else {
        const allowedPolicyFingerprint = [...new Set(ctx.allowedPolicies)].sort().join("\u0000");
        const previousEpochState = policyEpochByProject.get(epochKey) ?? {
          epoch: 1,
          revocationFingerprint: null,
          allowedPolicyFingerprint
        };
        const revocationFingerprint = revokedPolicies.length > 0 ? [...new Set(revokedPolicies)].sort().join("\u0000") : null;
        const newRevocation = Boolean(revocationFingerprint && revocationFingerprint !== previousEpochState.revocationFingerprint);
        const policyScopeChanged = allowedPolicyFingerprint !== previousEpochState.allowedPolicyFingerprint;
        nextEpoch = newRevocation || policyScopeChanged
          ? previousEpochState.epoch + 1
          : previousEpochState.epoch;
        policyEpochByProject.set(epochKey, { epoch: nextEpoch, revocationFingerprint, allowedPolicyFingerprint });
      }

      const sinceSeq = req.body.sinceSeq ?? 0;
      const pageSize = req.body.pageSize ?? 100;
      const snapshotContinuation = req.body.snapshotSeq !== undefined || req.body.snapshotCursor !== undefined;
      const deltaMode = Boolean(
        opRepo && pgKnowledge && sinceSeq > 0 && req.body.policyEpoch === nextEpoch && !snapshotContinuation
      );
      const pgChanges = deltaMode
        ? await opRepo!.pullSyncChanges(ctx, req.body.projectId, sinceSeq, pageSize)
        : [];
      let items: unknown[];
      let tombstones: string[];
      let syncMode: "snapshot" | "delta" = "snapshot";
      let snapshotSeq: number | undefined;
      let snapshotCursor: string | null = null;
      let snapshotDone = true;
      let snapshotRestarted = false;
      let responseSyncSeq = sinceSeq;
      if (deltaMode) {
        // Once the Edge has a cursor, hydrate only the newest journal entry for each
        // changed item. RLS through getItem prevents the delta from exposing a policy
        // the actor can no longer read; that item becomes a local tombstone instead.
        const latestChangeByItem = new Map<string, (typeof pgChanges)[number]>();
        for (const change of pgChanges) latestChangeByItem.set(change.itemId, change);
        const deltaItems: unknown[] = [];
        tombstones = [];
        for (const change of latestChangeByItem.values()) {
          const current = change.deletedAt
            ? undefined
            : await pgKnowledge!.getItem(ctx, req.body.projectId, change.itemId);
          if (current) deltaItems.push(current);
          else tombstones.push(change.itemId);
        }
        items = deltaItems;
        syncMode = "delta";
        responseSyncSeq = pgChanges.reduce((m, c) => Math.max(m, c.syncSeq), sinceSeq);
      } else {
        snapshotRestarted = snapshotContinuation && req.body.policyEpoch !== nextEpoch;
        const cursor = snapshotRestarted ? undefined : req.body.snapshotCursor;
        snapshotSeq = snapshotRestarted || req.body.snapshotSeq === undefined
          ? (opRepo ? await opRepo.getLatestSyncSeq(ctx, req.body.projectId) : sinceSeq)
          : req.body.snapshotSeq;
        if (opRepo && pgKnowledge) {
          const page = await pgKnowledge.listSyncSnapshot(ctx, req.body.projectId, cursor, pageSize);
          items = page;
          snapshotDone = page.length < pageSize;
          snapshotCursor = snapshotDone ? null : page.at(-1)?.id ?? null;
        } else {
          const hits = await queryAwareRetrieval.search(ctx, { projectId: req.body.projectId, query: "", limit: pageSize });
          items = hits.map((h) => h.item);
        }
        tombstones = [];
        responseSyncSeq = snapshotSeq;
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.body.projectId,
        accessPolicyId: ctx.allowedPolicies[0] ?? "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "sync_pull",
        targetType: "edge_snapshot",
        metadata: { count: items.length, revokedPolicies, policyEpoch: nextEpoch, sinceSeq, syncMode, snapshotSeq, snapshotCursor, snapshotDone, snapshotRestarted }
      });

      return {
        syncMode,
        syncSeq: responseSyncSeq,
        policyEpoch: nextEpoch,
        revokedPolicies,
        items,
        tombstones,
        ...(syncMode === "snapshot" ? { snapshotSeq, snapshotCursor, snapshotDone, snapshotRestarted } : {})
      };
    }
  );

  // Edge Sync: Push controlado via Ingestion Gate (sempre como draft)
  app.post(
    "/v1/sync/push",
    {
      schema: {
        body: Type.Object({
          projectId: Type.String(),
          drafts: Type.Array(
            Type.Object({
              id: Type.String(),
              title: Type.String(),
              content: Type.String(),
              accessPolicyId: Type.Optional(Type.String()),
              baseVersion: Type.Optional(Type.Number())
            })
          )
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
      const accepted: string[] = [];
      const conflicts: Array<{ id: string; proposalId: string; conflictWithVersion: number; status: "draft" }> = [];

      for (const draft of req.body.drafts) {
        const scan = scanForSecrets(`${draft.title}\n${draft.content}`);
        assertSecretScanClean(scan, `Segredo detectado no sync push (${draft.id})`);
        const [redactedContent, redactedTitle] = await Promise.all([
          redactPiiWithAiWorker(draft.content), redactPiiWithAiWorker(draft.title)
        ]);
        const policy = draft.accessPolicyId ?? "internal-project";
        assertPolicyAccess(ctx, policy);

        const existing =
          draft.baseVersion !== undefined
            ? pgRetrieval
              ? await pgRetrieval.getItem(ctx, req.body.projectId, draft.id)
              : retrieval.getItem(ctx, req.body.projectId, draft.id)
            : undefined;

        if (existing && draft.baseVersion !== undefined && existing.version > draft.baseVersion) {
          const conflictProposalId = `${draft.id}-conflict-v${existing.version}`;
          const conflictItem = parseKnowledgeFile({
            tenantId: ctx.tenantId,
            projectId: req.body.projectId,
            filePath: `.brain/08-agent-memory/${conflictProposalId}.md`,
            rawContent: `---\nid: ${conflictProposalId}\ntitle: ${redactedTitle}\nstatus: draft\naccess_policy: ${policy}\n---\n\n${redactedContent}`
          });
          conflictItem.metadata = { ...conflictItem.metadata, conflictWithVersion: existing.version, conflictForId: draft.id };
          await upsertKnowledgeItem(ctx, conflictItem);
          const conflictRequest = pgApprovals ? await pgApprovals.submit(ctx, conflictItem) : approvals.submit(ctx, conflictItem);
          await enqueueApprovalReminders(conflictRequest);
          conflicts.push({
            id: draft.id,
            proposalId: conflictProposalId,
            conflictWithVersion: existing.version,
            status: "draft"
          });
          accepted.push(conflictProposalId);
          continue;
        }

        const item = parseKnowledgeFile({
          tenantId: ctx.tenantId,
          projectId: req.body.projectId,
          filePath: `.brain/08-agent-memory/${draft.id}.md`,
          rawContent: `---\nid: ${draft.id}\ntitle: ${redactedTitle}\nstatus: draft\naccess_policy: ${policy}\n---\n\n${redactedContent}`
        });
        await upsertKnowledgeItem(ctx, item);
        accepted.push(item.id);
      }

      pgRetrieval?.invalidateCache(ctx.tenantId, req.body.projectId);

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.body.projectId,
        accessPolicyId: ctx.allowedPolicies[0] ?? "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "sync_push",
        targetType: "edge_drafts",
        metadata: { accepted, conflicts }
      });

      return {
        acceptedCount: accepted.length,
        acceptedIds: accepted,
        status: "draft",
        ...(conflicts.length > 0 ? { conflicts } : {})
      };
    }
  );

  // Listagem e aprovação de propostas (para Command Center apps/web) com paginação cursor-based
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/notification-preferences", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (ctx.actorType !== "human") throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Preferências de notificação são pessoais e só podem ser lidas por uma pessoa.", 403);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
    return { preferences: await getNotificationPreferences(ctx, req.params.projectId, "internal-project") };
  });

  app.put("/v1/projects/:projectId/notification-preferences", {
    schema: {
      params: Type.Object({ projectId: Type.String() }),
      body: Type.Object({ channels: Type.Array(Type.String()), categories: Type.Array(Type.String()), frequency: Type.String() })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (ctx.actorType !== "human") throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Preferências de notificação são pessoais e só podem ser alteradas por uma pessoa.", 403);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    let preferences: NotificationPreferences;
    try { preferences = normalizeNotificationPreferences(req.body); }
    catch (err) { throw new BrainError("BRAIN_ERR_CONFLICT", err instanceof Error ? err.message : "Preferências inválidas.", 400); }
    const key = notificationPreferenceKey(ctx, req.params.projectId, "internal-project");
    if (opRepo) {
      await opRepo.saveNotificationPreferences(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", ...preferences });
    } else {
      memoryNotificationPreferences.set(key, preferences);
    }
    await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project", actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "notification_preferences", targetId: ctx.actorId, metadata: { channels: preferences.channels, categories: preferences.categories, frequency: preferences.frequency } });
    return { preferences };
  });

  app.delete<{ Params: { projectId: string } }>("/v1/projects/:projectId/notification-preferences", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (ctx.actorType !== "human") throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Preferências de notificação são pessoais e só podem ser redefinidas por uma pessoa.", 403);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const key = notificationPreferenceKey(ctx, req.params.projectId, "internal-project");
    if (opRepo) await opRepo.clearNotificationPreferences(ctx, req.params.projectId, "internal-project");
    else memoryNotificationPreferences.delete(key);
    const preferences = defaultNotificationPreferences();
    await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project", actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "notification_preferences", targetId: ctx.actorId, metadata: { reset: true } });
    return { preferences };
  });

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/v1/projects/:projectId/proposals",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const requests = pgApprovals
        ? await pgApprovals.listPending(ctx, req.params.projectId)
        : approvals.listPending(ctx, req.params.projectId);
      const pending = requests.map((request) => ({ ...request.item, assignedTo: request.assignedTo, dueAt: request.dueAt, overdue: Date.parse(request.dueAt) <= Date.now() }));
      const page = paginateCursor(pending, Number(req.query.limit ?? 20), req.query.cursor);
      return { proposals: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/approval-reminders", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (!opRepo) return { reminders: [] };
    return { reminders: await opRepo.listApprovalReminderEvents(ctx, req.params.projectId) };
  });

  app.get<{ Params: { projectId: string; proposalId: string } }>(
    "/v1/projects/:projectId/proposals/:proposalId/history",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgKnowledge
        ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId)
        : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "read", domainId: item.domainId });
      const memoryEvents = (auditLogger as (AuditLogger & { events?: Array<Record<string, unknown>> }) | undefined)?.events;
      const events = opRepo
        ? await opRepo.listProposalAuditHistory(ctx, req.params.projectId, req.params.proposalId)
        : (memoryEvents ?? []).filter((event) => event.projectId === req.params.projectId && event.targetId === req.params.proposalId && ["proposal", "proposal_revision", "approval_decision", "integration_approval_event", "proposal_assignment"].includes(String(event.targetType)));
      return { proposalId: req.params.proposalId, events };
    }
  );

  app.post("/v1/projects/:projectId/proposals/:proposalId/assign", {
    schema: {
      params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
      body: Type.Object({ provider: Type.String({ minLength: 1 }), externalUserId: Type.String({ minLength: 1 }) })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgKnowledge
      ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId)
      : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
    if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "approve", domainId: item.domainId });
    const provider = req.body.provider.toLowerCase();
    const reviewer = mapExternalHumanActor(ctx, provider, req.body.externalUserId, req.params.projectId, item.accessPolicyId);
    if (!canApproveDomain(reviewer, item.domainId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O revisor mapeado não pode aprovar este domínio.", 403);
    const assigned = pgApprovals
      ? await pgApprovals.assign(ctx, req.params.projectId, req.params.proposalId, reviewer.actorId)
      : approvals.assign(ctx, req.params.projectId, req.params.proposalId, reviewer.actorId);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: item.accessPolicyId,
      actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "proposal_assignment",
      targetId: req.params.proposalId, metadata: { assignedTo: reviewer.actorId, provider, externalUserId: req.body.externalUserId }
    });
    return { proposalId: req.params.proposalId, assignedTo: assigned.assignedTo, status: assigned.status };
  });

  app.get<{ Params: { projectId: string }; Querystring: { rootId?: string; depth?: string } }>(
    "/v1/projects/:projectId/graph",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const rootId = req.query.rootId ?? "BR-1";
      const depth = Number(req.query.depth ?? 2);
      const edges = pgGraph
        ? await pgGraph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: rootId }, depth)
        : graph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: rootId }, depth);
      return { projectId: req.params.projectId, rootId, edges };
    }
  );

  app.post<{ Params: { projectId: string; proposalId: string } }>(
    "/v1/projects/:projectId/proposals/:proposalId/approve",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgRetrieval
        ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.proposalId)
        : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      }
      if (ctx.actorType === "agent") {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Agentes não podem aprovar conhecimento oficial.", 403);
      }
      const approved = { ...item, status: "approved" as const, isInferred: false, updatedAt: new Date().toISOString() };
      await upsertKnowledgeItem(ctx, approved);
      if (pgApprovals) {
        try {
          await pgApprovals.decide(ctx, req.params.projectId, req.params.proposalId, true);
        } catch (err) {
          if (!(err instanceof BrainError && err.code === "BRAIN_ERR_NOT_FOUND")) {
            throw err;
          }
        }
      }
      pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);

      let prUrl: string | undefined;
      const ghToken = process.env.GITHUB_TOKEN;
      const ghRepo = process.env.GITHUB_REPO; // ex: "acme/sub"
      if (ghToken && ghRepo && ghRepo.includes("/")) {
        const [owner, repo] = ghRepo.split("/");
        const headBranch = `brain/${item.id.toLowerCase()}`;
        const commitTitle = `chore(brain): approve ${item.id}`;
        await createBranchAndCommitFiles(
          owner!,
          repo!,
          "main",
          headBranch,
          [{ path: item.sourceUri || `.brain/01-business/${item.id}.md`, content: approved.content }],
          commitTitle,
          ghToken
        );
        const pr = await createGitHubPullRequest({
          owner: owner!,
          repo: repo!,
          title: commitTitle,
          head: headBranch,
          base: "main",
          body: `Aprovado por ${ctx.actorId} via Noema Command Center.`,
          token: ghToken
        });
        prUrl = pr.htmlUrl;
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "approve",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: prUrl ? { prUrl } : undefined
      });
      return { approved: true, id: item.id, status: "approved", ...(prUrl ? { prUrl } : {}) };
    }
  );

  // Decisão canônica de aprovação (mcp-and-api-spec.md §5 & Normativo 86-87)
  app.post(
    "/v1/projects/:projectId/approvals/:proposalId/decision",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
        body: Type.Object({
          approved: Type.Optional(Type.Boolean()),
          decision: Type.Optional(Type.Union([
            Type.Literal("approve"),
            Type.Literal("reject"),
            Type.Literal("request_changes")
          ])),
          proposalVersion: Type.Integer({ minimum: 1 }),
          comment: Type.Optional(Type.String()),
          channel: Type.Optional(Type.String()),
          externalEventId: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const decision = req.body.decision ?? (req.body.approved === undefined ? undefined : req.body.approved ? "approve" : "reject");
      if (!decision) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe decision: approve, reject ou request_changes.", 400);
      }
      if (ctx.actorType === "agent") {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Agentes não podem aprovar ou rejeitar propostas.", 403);
      }
      const item = pgKnowledge
        ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId)
        : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      }
      await enforceOpa(ctx, {
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        action: "approve",
        domainId: item.domainId
      });
      const channel = req.body.channel?.trim() || "api";
      const externalEventId = req.body.externalEventId?.trim();
      const eventProvider = `direct:${channel.toLowerCase()}`;
      const eventKey = `${ctx.tenantId}:${eventProvider}:${externalEventId ?? ""}`;
      let directEventClaimed = false;
      if (req.body.externalEventId !== undefined) {
        if (!externalEventId) throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId não pode estar vazio.", 400);
        const eventHash = createHash("sha256").update(JSON.stringify({
          projectId: req.params.projectId,
          proposalId: req.params.proposalId,
          proposalVersion: req.body.proposalVersion,
          decision,
          comment: req.body.comment ?? "",
          channel,
          actorId: ctx.actorId
        })).digest("hex");
        if (opRepo) {
          const claim = await opRepo.claimIntegrationEvent(ctx, {
            provider: eventProvider, externalEventId, projectId: req.params.projectId,
            proposalId: req.params.proposalId, accessPolicyId: item.accessPolicyId, eventHash
          });
          if (claim.state === "duplicate" && claim.response) return { ...claim.response, duplicate: true };
          if (claim.state === "key_conflict") throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
          if (claim.state !== "claimed") throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de decisão ainda está sendo processado.", 409);
          directEventClaimed = true;
        } else {
          const existing = integrationEventMemory.get(eventKey);
          if (!existing) {
            integrationEventMemory.set(eventKey, { eventHash });
            directEventClaimed = true;
          } else if (existing.eventHash !== eventHash) {
            throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
          } else if (existing.response) {
            return { ...existing.response, duplicate: true };
          } else {
            throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de decisão ainda está sendo processado.", 409);
          }
        }
      }
      try {
      if (item.version !== req.body.proposalVersion) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de decidir.`, 409);
      }
      if (pgApprovals) {
        try {
          await pgApprovals.decide(ctx, req.params.projectId, req.params.proposalId, decision, req.body.comment);
        } catch (err) {
          const code = (err as { code?: string } | undefined)?.code;
          if (code !== "BRAIN_ERR_NOT_FOUND") throw err;
        }
      } else if (approvals.hasRequest(ctx, req.params.projectId, item.id)) {
        approvals.decide(ctx, req.params.projectId, req.params.proposalId, decision, req.body.comment);
      }
      const nextStatus = decision === "approve" ? ("approved" as const) : decision === "reject" ? ("deprecated" as const) : item.status;
      const updated = {
        ...item,
        status: nextStatus,
        isInferred: decision === "approve" ? false : item.isInferred,
        updatedAt: new Date().toISOString()
      };
      await upsertKnowledgeItem(ctx, updated);
      pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: decision === "approve" ? "approve" : decision === "reject" ? "revoke" : "update",
        targetType: "approval_decision",
        targetId: item.id,
        metadata: {
          decision,
          approved: decision === "approve",
          channel,
          externalEventId,
          comment: req.body.comment
        }
      });
      const response = {
        proposalId: item.id,
        decision: decision === "request_changes" ? "changes_requested" : decision === "approve" ? "approved" : "rejected",
        status: decision === "request_changes" ? "changes_requested" : nextStatus,
        knowledgeStatus: nextStatus,
        channel
      };
      if (directEventClaimed && externalEventId) {
        if (opRepo) await opRepo.completeIntegrationEvent(ctx, { provider: eventProvider, externalEventId, response });
        else integrationEventMemory.set(eventKey, { eventHash: createHash("sha256").update(JSON.stringify({
          projectId: req.params.projectId, proposalId: req.params.proposalId, proposalVersion: req.body.proposalVersion,
          decision, comment: req.body.comment ?? "", channel, actorId: ctx.actorId
        })).digest("hex"), response });
      }
      return response;
      } catch (err) {
        if (directEventClaimed && externalEventId) {
          try {
            if (opRepo) await opRepo.releaseIntegrationEvent(ctx, eventProvider, externalEventId);
            else integrationEventMemory.delete(eventKey);
          } catch { /* preserve the original decision error */ }
        }
        throw err;
      }
    }
  );

  app.post("/v1/projects/:projectId/proposals/:proposalId/revise", {
    schema: {
      params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
      body: Type.Object({ baseVersion: Type.Integer({ minimum: 1 }), content: Type.String({ minLength: 1 }) })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgKnowledge
      ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId)
      : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
    if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
    if (item.version !== req.body.baseVersion) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de revisar.`, 409);
    }
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
    const content = req.body.content.trim();
    if (!content) throw new BrainError("BRAIN_ERR_CONFLICT", "O conteúdo revisado não pode estar vazio.", 400);
    const revisedItem: KnowledgeItem = {
      ...item,
      content,
      status: "draft",
      version: item.version + 1,
      contentHash: createHash("sha256").update(content).digest("hex"),
      updatedAt: new Date().toISOString()
    };
    const revisedRequest = pgApprovals ? await pgApprovals.revise(ctx, req.params.projectId, req.params.proposalId, revisedItem) : approvals.revise(ctx, req.params.projectId, req.params.proposalId, revisedItem);
    await enqueueApprovalReminders(revisedRequest);
    await upsertKnowledgeItem(ctx, revisedItem);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: item.accessPolicyId,
      actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "proposal_revision",
      targetId: req.params.proposalId, metadata: { baseVersion: item.version, version: revisedItem.version, reopened: true }
    });
    return { proposalId: req.params.proposalId, status: "pending", version: revisedItem.version };
  });

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { channel: HumanOpsChannel; webhookUrl?: string; reviewUrl?: string };
  }>("/v1/projects/:projectId/proposals/:proposalId/notify", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgKnowledge
      ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId)
      : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
    if (!item) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
    }
    const preferences = await getNotificationPreferences(ctx, req.params.projectId, "internal-project");
    if (!notificationPreferenceAllows(preferences, req.body.channel, "approval")) {
      return { delivered: false, suppressed: true, channel: req.body.channel, reason: "Canal ou categoria desativada nas preferências pessoais." };
    }
    const envWebhookMap: Record<HumanOpsChannel, string | undefined> = {
      slack: process.env.NOEMA_SLACK_WEBHOOK_URL,
      teams: process.env.NOEMA_TEAMS_WEBHOOK_URL,
      jira: process.env.NOEMA_JIRA_WEBHOOK_URL,
      clickup: process.env.NOEMA_CLICKUP_WEBHOOK_URL,
      email: process.env.NOEMA_EMAIL_WEBHOOK_URL
    };
    const webhookUrl = req.body.webhookUrl ?? envWebhookMap[req.body.channel];
    if (!webhookUrl) {
      return {
        delivered: false,
        channel: req.body.channel,
        reason: `Webhook para canal '${req.body.channel}' não configurado.`
      };
    }
    if (preferences.frequency !== "immediate") {
      if (!envWebhookMap[req.body.channel]) return { delivered: false, channel: req.body.channel, reason: "Digest exige o webhook do canal configurado no servidor." };
      const queued = await queueNotificationDigest(ctx, {
        projectId: req.params.projectId, channel: req.body.channel, category: "approval",
        targetId: item.id, title: item.title, frequency: preferences.frequency
      });
      await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "channel_notification", targetId: item.id, metadata: { channel: req.body.channel, queued: true, scheduledAt: queued.scheduledAt } });
      return queued;
    }
    const result = await dispatchChannelNotification({
      channel: req.body.channel,
      webhookUrl,
      projectId: req.params.projectId,
      proposalId: item.id,
      proposalVersion: item.version,
      title: item.title,
      reviewUrl: req.body.reviewUrl ?? `${process.env.NOEMA_CORS_ORIGIN ?? "http://localhost:3000"}`
    });
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: item.accessPolicyId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "channel_notification",
      targetId: item.id,
      metadata: { channel: req.body.channel, delivered: result.delivered, statusCode: result.statusCode }
    });
    return result;
  });

  // Resposta humana para tarefa do Brain Runner (mcp-and-api-spec.md §5)
  app.post(
    "/v1/projects/:projectId/runner/tasks/:taskId/responses",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
        body: Type.Object({
          questionId: Type.String({ minLength: 1 }),
          response: Type.String({ minLength: 1 }),
          idempotencyKey: Type.String({ minLength: 1 })
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (ctx.actorType !== "human") {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Somente uma pessoa autenticada pode responder perguntas do Runner.", 403);
      }
      await enforceOpa(ctx, {
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        action: "write"
      });
      const result = opRepo
        ? await opRepo.answerRunnerQuestion(ctx, {
            projectId: req.params.projectId,
            taskId: req.params.taskId,
            questionId: req.body.questionId,
            response: req.body.response,
            idempotencyKey: req.body.idempotencyKey
          })
        : (() => {
            const answered = runner.answerQuestion(ctx, req.params.taskId, {
              questionId: req.body.questionId,
              response: req.body.response,
              idempotencyKey: req.body.idempotencyKey
            });
            return {
              questionId: answered.question.questionId,
              status: "queued" as const,
              responseRecorded: true as const,
              duplicate: answered.duplicate
            };
          })();
      if (!result.duplicate) {
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "runner_task_response",
          targetId: req.params.taskId,
          metadata: { questionId: req.body.questionId, idempotencyKey: req.body.idempotencyKey, resumed: true }
        });
      }
      return { taskId: req.params.taskId, ...result };
    }
  );

  // Universal Agent Gateway + MCP Streamable HTTP (Item 7 & 37)
  app.get("/gateway", async () => ({
    gateway: "noema-universal-agent-gateway",
    transports: ["streamable-http", "stdio", "rest"],
    mcpEndpoint: "/mcp",
    toolsCount: 14,
    pgStoresEnabled: Boolean(pgGraph && pgRetrieval)
  }));

  app.post("/mcp", async (req, reply) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpRuntime = {
      graph: pgGraph ?? graph,
      retrieval: queryAwareRetrieval,
      contextEngine,
      handoffs,
      runner,
      scheduleRunnerTask: (process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL)
        ? async (input: Parameters<typeof createRunnerSchedule>[0] & { cron: string }) => ({
            scheduleId: await createRunnerSchedule(input, input.cron, process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL!)
          })
        : undefined,
      opRepo,
      memory: pgMemory,
      knowledge: pgKnowledge,
      crossServiceRegistry: pgCrossService ?? crossService,
      approvals: pgApprovals,
      audit: {
        record: (event: Parameters<AuditLogger["record"]>[0]) => recordAudit(ctx, event)
      }
    };
    const mcpServer = createNoemaMcpServer(mcpRuntime as never, ctx, "internal-project");
    await mcpServer.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // LGPD: Privacy Erase (Item 56)
  app.post<{ Body: { subjectId: string; projectId: string } }>("/v1/privacy/erase", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
    const opaAllowed = await evaluateOpaPolicy(ctx, {
      projectId: req.body.projectId,
      accessPolicyId: "internal-project",
      action: "write"
    });
    if (!opaAllowed) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "OPA negou operação de privacy erase.", 403);
    }
    if (!systemKnowledgeClient || process.env.NOEMA_PG_STORES !== "1") {
      throw new BrainError(
        "BRAIN_ERR_STORAGE_UNAVAILABLE",
        "Privacy erase exige DATABASE_SYSTEM_URL com a role brain_system e armazenamento PostgreSQL ativo; nenhum registro foi alterado.",
        503
      );
    }
    const erased = await privacyEraseSubject(systemKnowledgeClient, {
      tenantId: ctx.tenantId,
      subjectId: req.body.subjectId,
      projectId: req.body.projectId
    });
    const deletedFromPg = erased.deletedItems;
    pgRetrieval?.invalidateCache(ctx.tenantId, req.body.projectId);

    // Crypto-shredding: destroy subject key material reference (persisted in PostgreSQL when opRepo is active)
    const subjectKeyId = `${ctx.tenantId}:${req.body.projectId}:${req.body.subjectId}`;
    shreddedSubjectKeys.add(subjectKeyId);
    if (opRepo) {
      await opRepo.recordLgpdShreddedSubject(ctx, req.body.projectId, req.body.subjectId);
    }
    const cryptoShredded = true;

    // Historical audit_logs anonymization (preserving hash/sequence structure, removing PII actor_id)
    const anonymizedActorId = `anon:${createHash("sha256").update(subjectKeyId).digest("hex").slice(0, 16)}`;
    let auditLogsAnonymized = 0;
    try {
      const runUpdate = async (runner: { (strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): PromiseLike<unknown> }) =>
        runner`
          UPDATE audit_logs
          SET actor_id = ${anonymizedActorId}
          WHERE tenant_id = ${ctx.tenantId} AND project_id = ${req.body.projectId} AND actor_id = ${req.body.subjectId}
          RETURNING id
        `;
      const anonRes = ("begin" in systemKnowledgeClient && typeof systemKnowledgeClient.begin === "function"
        ? await systemKnowledgeClient.begin((tx) => runUpdate(tx))
        : await runUpdate(systemKnowledgeClient as unknown as Parameters<typeof runUpdate>[0])) as unknown[];
      auditLogsAnonymized = Array.isArray(anonRes) ? anonRes.length : 0;
    } catch {
      // If audit_logs is append-only/protected by trigger in some deployments, keep going and report accurately
      auditLogsAnonymized = 0;
    }

    // Optional MinIO / Object Storage deletion hook
    const objectStorageUrl = process.env.NOEMA_OBJECT_STORAGE_URL ?? process.env.MINIO_ENDPOINT;
    let objectStorageDeleted = false;
    let objectStorageStatus: "deleted" | "not_configured" | "failed" = "not_configured";
    if (objectStorageUrl) {
      try {
        const res = await fetch(`${objectStorageUrl.replace(/\/$/, "")}/privacy/erase`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: ctx.tenantId, projectId: req.body.projectId, subjectId: req.body.subjectId })
        });
        objectStorageDeleted = res.ok;
        objectStorageStatus = res.ok ? "deleted" : "failed";
      } catch {
        objectStorageDeleted = false;
        objectStorageStatus = "failed";
      }
    }

    const complete = cryptoShredded && objectStorageStatus !== "failed";
    const limitations: string[] = [];
    if (objectStorageStatus === "not_configured") {
      limitations.push("MinIO/Object Storage não configurado neste ambiente (nenhum bucket externo ativo)");
    } else if (objectStorageStatus === "failed") {
      limitations.push("Falha ao remover objetos do MinIO/Object Storage");
    }
    if (erased.createdSyncTombstones > 0) {
      limitations.push("Cópias Edge serão removidas após sincronização do tombstone");
    }

    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.body.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "revoke",
      targetType: "privacy_erase",
      targetId: createHash("sha256").update(subjectKeyId).digest("hex"),
      metadata: {
        deletedFromPg,
        deletedVersions: erased.deletedVersions,
        deletedEmbeddings: erased.deletedEmbeddings,
        deletedRelations: erased.deletedRelations,
        createdSyncTombstones: erased.createdSyncTombstones,
        deletedMemories: erased.deletedMemories,
        deletedHandoffs: erased.deletedHandoffs,
        deletedRunnerQuestions: erased.deletedRunnerQuestions,
        deletedRunnerTasks: erased.deletedRunnerTasks,
        deletedTaskLeases: erased.deletedTaskLeases,
        deletedNotificationPreferences: erased.deletedNotificationPreferences,
        deletedNotificationOutbox: erased.deletedNotificationOutbox,
        canonicalKnowledgeRecordsDeleted: true,
        cryptoShredded,
        auditLogsAnonymized,
        objectStorageDeleted,
        objectStorageStatus,
        offlineCopiesInvalidated: erased.createdSyncTombstones > 0
      }
    });
    return {
      erased: true,
      deletedFromPg,
      deletedVersions: erased.deletedVersions,
      deletedEmbeddings: erased.deletedEmbeddings,
      deletedRelations: erased.deletedRelations,
      createdSyncTombstones: erased.createdSyncTombstones,
      deletedMemories: erased.deletedMemories,
      deletedHandoffs: erased.deletedHandoffs,
      deletedRunnerQuestions: erased.deletedRunnerQuestions,
      deletedRunnerTasks: erased.deletedRunnerTasks,
      deletedTaskLeases: erased.deletedTaskLeases,
      deletedNotificationPreferences: erased.deletedNotificationPreferences,
      deletedNotificationOutbox: erased.deletedNotificationOutbox,
      cryptoShredded,
      auditLogsAnonymized,
      objectStorageDeleted,
      objectStorageStatus,
      complete,
      limitations
    };
  });

  // Fase 5: Temporal Knowledge, Cross-Service & Enterprise Views
  app.post<{ Params: { projectId: string }; Body: { atTimestamp?: string; commitSha?: string } }>(
    "/v1/projects/:projectId/temporal/query",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (pgTemporal) {
        return { items: await pgTemporal.queryVersionsAt(ctx, { projectId: req.params.projectId, ...req.body }) };
      }
      return { items: temporal.queryAt(ctx, { projectId: req.params.projectId, ...req.body }) };
    }
  );

  app.post<{
    Body: {
      fromProjectId: string;
      fromService: string;
      relation: "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO";
      toProjectId: string;
      contractId: string;
      schemaVersion?: string;
      accessPolicyId?: string;
    };
  }>("/v1/cross-service/contracts", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    assertProjectAccess(ctx, req.body.fromProjectId);
    assertProjectAccess(ctx, req.body.toProjectId);
    const accessPolicyId = req.body.accessPolicyId ?? "internal-project";
    assertPolicyAccess(ctx, accessPolicyId);
    const edge = {
      tenantId: ctx.tenantId,
      fromProjectId: req.body.fromProjectId,
      fromService: req.body.fromService,
      relation: req.body.relation,
      toProjectId: req.body.toProjectId,
      contractId: req.body.contractId,
      schemaVersion: req.body.schemaVersion ?? "1.0.0",
      accessPolicyId
    };
    if (pgCrossService) {
      await pgCrossService.registerContract(edge, ctx);
    } else {
      crossService.registerContract(edge);
    }
    return { registered: true, edge };
  });

  app.post<{ Body: { contractId: string } }>("/v1/cross-service/blast-radius", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    if (pgCrossService) {
      return pgCrossService.computeDistributedBlastRadius(ctx, req.body.contractId);
    }
    return crossService.computeDistributedBlastRadius(ctx, req.body.contractId);
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/enterprise/views", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 100 });
    const items = hits.map((h) => h.item);
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const verifiedTests = evidence.verifiedTests;
    const qaCoverage = buildBusinessRuleTestCoverageMatrix(items, [], {
      linkedTestsByRule: evidence.linkedTestsByRule,
      testItemsById: evidence.testItemsById,
      requireMainHead: evidence.requireMainHead,
      requireRepositoryAssociation: evidence.requireRepositoryAssociation,
      mainHeadByRepository: evidence.mainHeadByRepository,
      testResults: evidence.testExecutionResults
    });
    return {
      techRadar: buildTechRadar(items),
      qaCoverage,
      testExecutionResults: evidence.testExecutionResults,
      health: projectHealth(items, verifiedTests)
    };
  });

  // Endpoints REST canônicos da especificação (mcp-and-api-spec.md §5)
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/overview", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const items = hits.map((h) => h.item);
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const verifiedTests = evidence.verifiedTests;
    const health = projectHealth(items, verifiedTests);
    const alerts: string[] = [];
    if (health.untestedRuleIds.length > 0) {
      alerts.push(`${health.untestedRuleIds.length} regra(s) sem cobertura de testes: ${health.untestedRuleIds.join(", ")}`);
    }
    if (health.staleItemIds.length > 0) {
      alerts.push(`${health.staleItemIds.length} item(ns) desatualizado(s) (>90d): ${health.staleItemIds.join(", ")}`);
    }
    if (health.gitVsConnectorConflicts.length > 0) {
      alerts.push(`${health.gitVsConnectorConflicts.length} conflito(s) Git vs Connector detectado(s).`);
    }
    return {
      projectId: req.params.projectId,
      totalItems: items.length,
      approvedCount: items.filter((i) => i.status === "approved").length,
      draftCount: items.filter((i) => i.status === "draft").length,
      health,
      alerts
    };
  });

  app.post<{
    Params: { projectId: string };
    Body: { query: string; domains?: number[]; limit?: number; cursor?: string; atDate?: string };
  }>(
    "/v1/projects/:projectId/search",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const { query, domains, limit, cursor, atDate } = req.body;
      const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query, domains, atDate, limit: 100 });
      const mapped = hits.map((h) => ({ ...h.item, score: h.score }));
      const reranked = await rerankWithAiWorker(query, mapped);
      const page = paginateCursor(reranked, limit ?? 20, cursor);
      return { items: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
  );

  app.get<{ Params: { projectId: string; itemId: string }; Querystring: { sessionId?: string } }>(
    "/v1/projects/:projectId/knowledge/:itemId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgRetrieval
        ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.itemId)
        : retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
      if (!item) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${req.params.itemId}' não encontrado.`, 404);
      }
      if (req.query.sessionId && opRepo) {
        await opRepo.recordContextEvidence(ctx, req.params.projectId, req.query.sessionId, [item.id], "read");
        pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
      }
      const relations = pgGraph
        ? await pgGraph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: req.params.itemId }, 1)
        : graph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: req.params.itemId }, 1);
      return { item, relations };
    }
  );

  app.get<{ Params: { projectId: string; itemId: string } }>(
    "/v1/projects/:projectId/knowledge/:itemId/versions",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (pgKnowledge) {
        const versions = await pgKnowledge.listVersions(ctx, req.params.projectId, req.params.itemId);
        return { itemId: req.params.itemId, versions };
      }
      const item = retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
      return { itemId: req.params.itemId, versions: item ? [item] : [] };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { query: string; rating: "useful" | "incomplete" | "incorrect"; itemIds?: string[]; comment?: string; sessionId?: string; taskId?: string; editedPaths?: string[] };
  }>("/v1/projects/:projectId/search/feedback", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const itemIds = [...new Set(req.body.itemIds ?? [])];
    let hitRate = null;
    const evidenceWarnings: string[] = [];
    if (req.body.rating === "useful" && itemIds.length > 0) {
      if (!req.body.sessionId || !opRepo) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId e persistência de sessão são necessários para feedback útil com itens.", 400);
      for (const itemId of itemIds) {
        const item = pgRetrieval
          ? await pgRetrieval.getItem(ctx, req.params.projectId, itemId)
          : retrieval.getItem(ctx, req.params.projectId, itemId);
        if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${itemId}' não encontrado ou sem permissão.`, 404);
      }
      const result = await opRepo.recordContextEvidence(ctx, req.params.projectId, req.body.sessionId, itemIds, "citation");
      hitRate = result.rate;
      pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
    }
    if (req.body.taskId || (req.body.editedPaths?.length ?? 0) > 0) {
      if (!req.body.sessionId || !req.body.taskId || !opRepo) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId, taskId e persistência de sessão são necessários para evidência de edição.", 400);
      const lease = await opRepo.getTaskLease(ctx, req.params.projectId, req.body.taskId);
      if (!lease || lease.actorId !== ctx.actorId) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Evidência de edição requer lease ativo do ator autenticado.", 403);
      const candidates = await opRepo.getContextEditCandidates(ctx, req.params.projectId, req.body.sessionId, req.body.taskId);
      const changedSources = await findChangedWorkspaceSources(configuredWorkspaceRoot(req.params.projectId), candidates);
      const requested = req.body.editedPaths?.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean);
      const requestedSet = requested ? new Set(requested) : undefined;
      const confirmedPaths = requestedSet ? changedSources.filter((path) => requestedSet.has(path)) : changedSources;
      const editResult = await opRepo.recordContextEdits(ctx, req.params.projectId, req.body.sessionId, req.body.taskId, confirmedPaths);
      hitRate = editResult.rate;
      const candidatePaths = new Set(candidates.map((candidate) => candidate.sourceUri));
      if (candidates.length === 0) evidenceWarnings.push("Nenhuma fonte local com hash de baseline foi entregue nesta sessão e tarefa; evidência automática de diff indisponível.");
      else if (!requested && changedSources.length === 0) evidenceWarnings.push("Nenhuma fonte local entregue mudou desde a montagem do Context Pack.");
      for (const path of requested ?? []) {
        if (!candidatePaths.has(path)) evidenceWarnings.push(`O caminho '${path}' não tem hash de baseline para esta sessão e tarefa.`);
        else if (!changedSources.includes(path)) evidenceWarnings.push(`O caminho '${path}' não mudou desde a entrega do Context Pack.`);
      }
      pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
    }
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "search_feedback",
      targetId: (req.body.query ?? req.body.sessionId ?? "").slice(0, 120),
      metadata: {
        rating: req.body.rating,
        itemIds,
        comment: req.body.comment
      }
    });
    return { recorded: true, rating: req.body.rating, hitRate, warnings: evidenceWarnings };
  });

  app.get<{ Params: { projectId: string; itemId: string }; Querystring: { depth?: string } }>(
    "/v1/projects/:projectId/graph/:itemId/related",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const depth = Number(req.query.depth ?? 2);
      const edges = pgGraph
        ? await pgGraph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: req.params.itemId }, depth)
        : graph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: req.params.itemId }, depth);
      return { projectId: req.params.projectId, itemId: req.params.itemId, edges };
    }
  );

  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (process.env.NOEMA_PG_STORES === "1") {
        const opGetTask = (opRepo as { getRunnerTask?: (c: typeof ctx, projectId: string, taskId: string) => Promise<unknown> } | undefined)?.getRunnerTask;
        if (opGetTask) {
          const found = await opGetTask.call(opRepo, ctx, req.params.projectId, req.params.taskId);
          if (found) return found;
        } else if (appPostgresClient) {
          const pgTask = await appPostgresClient.withRlsTransaction(
            {
              tenantId: ctx.tenantId,
              allowedProjects: ctx.allowedProjects,
              allowedPolicies: ctx.allowedPolicies
            },
            async (client) => {
              const rows = (await client`
                SELECT task_id, tenant_id, project_id, instruction, priority, draft_only, max_steps, timeout_seconds, status, result_summary, result_metadata, created_at
                FROM runner_tasks
                WHERE tenant_id = ${ctx.tenantId}
                  AND project_id = ${req.params.projectId}
                  AND task_id = ${req.params.taskId}
                LIMIT 1
              `) as Array<Record<string, unknown>>;
              const row = rows[0];
              if (!row) return undefined;
              return {
                taskId: String(row.task_id),
                tenantId: String(row.tenant_id),
                projectId: String(row.project_id),
                instruction: String(row.instruction),
                priority: String(row.priority),
                draftOnly: Boolean(row.draft_only),
                maxSteps: Number(row.max_steps),
                timeoutSeconds: Number(row.timeout_seconds),
                status: String(row.status),
                ...(row.result_summary != null ? { resultSummary: String(row.result_summary) } : {}),
                ...(row.result_metadata != null ? { resultMetadata: row.result_metadata } : {}),
                createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
              };
            }
          );
          if (pgTask) return pgTask;
        }
      }
      const task = runner.getTask(ctx, req.params.taskId);
      if (!task) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Task '${req.params.taskId}' não encontrada.`, 404);
      }
      return task;
    }
  );

  app.post<{ Params: { projectId: string }; Body: { targetIds: string[] } }>(
    "/v1/projects/:projectId/change/impact",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const targetIds = [...new Set(req.body.targetIds ?? [])];
      if (targetIds.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe ao menos um targetId para analisar impacto.", 400);
      }
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "business_rule", domains: [2], limit: 200 });
      const report = await analyzeDistributedImpact(
        ctx,
        pgGraph ?? graph,
        req.params.projectId,
        targetIds,
        { rules: hits.map((hit) => hit.item), crossServiceRegistry: pgCrossService ?? crossService }
      );
      return {
        ...report
      };
    }
  );

  app.post(
    "/v1/projects/:projectId/change/propose",
    { schema: { params: Type.Object({ projectId: Type.String() }), body: Type.Object({
      title: Type.String({ minLength: 1 }),
      content: Type.String({ minLength: 1 }),
      targetType: Type.Optional(Type.String()),
      relatedIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })) )
    }) } },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const id = `PROP-${randomUUID()}`;
      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        filePath: `.brain/01-business/${id}.md`,
        rawContent: `---\nid: ${id}\ntitle: ${JSON.stringify(req.body.title)}\ntype: ${JSON.stringify(req.body.targetType ?? "business_rule")}\nstatus: draft\naccess_policy: internal-project\n---\n\n${req.body.content}`
      });
      const relatedIds = [...new Set(req.body.relatedIds ?? [])];
      if (relatedIds.includes(id)) throw new BrainError("BRAIN_ERR_CONFLICT", "A proposta não pode impactar a si mesma.", 400);
      const relatedTargets: KnowledgeItem[] = [];
      for (const targetId of relatedIds) {
        const target = pgKnowledge
          ? await pgKnowledge.getItem(ctx, req.params.projectId, targetId)
          : retrieval.getItem(ctx, req.params.projectId, targetId);
        if (!target) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Alvo de impacto '${targetId}' não encontrado.`, 404);
        assertPolicyAccess(ctx, target.accessPolicyId);
        await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: target.accessPolicyId, action: "read", domainId: target.domainId });
        relatedTargets.push(target);
      }
      await upsertKnowledgeItem(ctx, item);
      const approvalRequest = pgApprovals ? await pgApprovals.submit(ctx, item) : approvals.submit(ctx, item);
      await enqueueApprovalReminders(approvalRequest);
      for (const target of relatedTargets) {
        const edge = {
          tenantId: ctx.tenantId,
          fromProjectId: req.params.projectId,
          toProjectId: req.params.projectId,
          fromItemId: item.id,
          toItemId: target.id,
          fromPolicyId: item.accessPolicyId,
          toPolicyId: target.accessPolicyId,
          relationType: "IMPACTS" as const,
          isInferred: false,
          confidence: 1
        };
        graph.addEdge(edge);
        if (pgGraph) await pgGraph.addEdge(ctx, edge);
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "proposal",
        targetId: id,
        metadata: { title: req.body.title, relatedIds }
      });
      return { proposalId: id, status: "draft" };
    }
  );

  app.post("/v1/projects/:projectId/github/ingest", {
    schema: { params: Type.Object({ projectId: Type.String() }), body: Type.Object({
      owner: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9-]+$" }),
      repo: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" }),
      ref: Type.String({ minLength: 1, maxLength: 255 })
    }) }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    if (process.env.NOEMA_PG_BOSS !== "1") {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Ingestão GitHub remota exige o worker pg-boss ativo.", 503);
    }
    const jobId = await enqueueRemoteGitIngestJob({
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      owner: req.body.owner,
      repo: req.body.repo,
      ref: req.body.ref
    });
    if (!jobId) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Banco de dados do worker não está configurado.", 503);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
      actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "github_ingestion_job",
      targetId: jobId, metadata: { owner: req.body.owner, repo: req.body.repo, ref: req.body.ref }
    });
    return { accepted: true, provider: "github", owner: req.body.owner, repo: req.body.repo, ref: req.body.ref, jobId };
  });

  app.get(
    "/v1/projects/:projectId/github/jobs",
    { schema: {
      params: Type.Object({ projectId: Type.String() }),
      querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) })
    } },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      if (!ownedSystemSqlClient || process.env.NOEMA_PG_BOSS !== "1") {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Histórico de ingestão requer PostgreSQL e pg-boss ativos.", 503);
      }
      const rows = await ownedSystemSqlClient<Array<Record<string, unknown>>>`
        SELECT id, state, retry_count, created_on, started_on, completed_on, output,
          data->>'owner' AS owner, data->>'repo' AS repo, data->>'ref' AS ref
        FROM pgboss.job
        WHERE name = 'noema.ingest-git'
          AND data->>'tenantId' = ${ctx.tenantId}
          AND data->>'projectId' = ${req.params.projectId}
          AND data ? 'owner' AND data ? 'repo'
        ORDER BY created_on DESC
        LIMIT ${req.query.limit ?? 20}
      `;
      return {
        jobs: rows.map((row) => ({
          jobId: String(row.id),
          state: String(row.state),
          retries: Number(row.retry_count ?? 0),
          owner: String(row.owner),
          repo: String(row.repo),
          ref: String(row.ref),
          createdAt: row.created_on instanceof Date ? row.created_on.toISOString() : String(row.created_on),
          startedAt: row.started_on ? (row.started_on instanceof Date ? row.started_on.toISOString() : String(row.started_on)) : null,
          completedAt: row.completed_on ? (row.completed_on instanceof Date ? row.completed_on.toISOString() : String(row.completed_on)) : null,
          result: row.output ?? null
        }))
      };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/integrations/status", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
    const systemSql = ownedSystemSqlClient;
    let githubJobs: Array<Record<string, unknown>> = [];
    let saasJobs: Array<Record<string, unknown>> = [];
    if (systemSql && process.env.NOEMA_PG_BOSS === "1") {
      githubJobs = await systemSql<Array<Record<string, unknown>>>`
        SELECT id, state, retry_count, created_on, completed_on, data->>'owner' AS owner,
          data->>'repo' AS repo, data->>'ref' AS ref, output
        FROM pgboss.job WHERE name = 'noema.ingest-git'
          AND data->>'tenantId' = ${ctx.tenantId} AND data->>'projectId' = ${req.params.projectId}
          AND data ? 'owner' AND data ? 'repo'
        ORDER BY created_on DESC LIMIT 10
      `;
      saasJobs = await systemSql<Array<Record<string, unknown>>>`
        SELECT id, state, retry_count, created_on, completed_on, data->>'provider' AS provider,
          data->>'connectionId' AS connection_id, output
        FROM pgboss.job WHERE name = 'noema.ingest-saas'
          AND data->>'tenantId' = ${ctx.tenantId} AND data->>'projectId' = ${req.params.projectId}
        ORDER BY created_on DESC LIMIT 10
      `;
    }
    let githubMappings: Array<{ repository: string; accessPolicyId: string }> = [];
    const rawRepoMap = process.env.NOEMA_GITHUB_REPO_MAP_JSON;
    if (rawRepoMap) {
      let repoMap: unknown;
      try { repoMap = JSON.parse(rawRepoMap); }
      catch { throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503); }
      if (repoMap && typeof repoMap === "object" && !Array.isArray(repoMap)) {
        githubMappings = Object.entries(repoMap as Record<string, unknown>).flatMap(([repository, value]) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const mapping = value as Record<string, unknown>;
          if (mapping.tenantId !== ctx.tenantId || mapping.projectId !== req.params.projectId || typeof mapping.accessPolicyId !== "string") return [];
          return [{ repository, accessPolicyId: mapping.accessPolicyId }];
        });
      }
    }
    const githubMainHeads = opRepo
      ? await opRepo.listGitHubMainHeads(ctx, req.params.projectId)
      : [...githubMainHeadMemory.entries()]
        .filter(([key]) => key.startsWith(`${ctx.tenantId}:${req.params.projectId}:`))
        .map(([, head]) => head);
    const notificationChannels = ["slack", "teams", "jira", "clickup", "email"].map((provider) => ({
      provider,
      configured: Boolean(process.env[`NOEMA_${provider.toUpperCase()}_WEBHOOK_URL`])
    }));
    let slackActorMappingPresent = false;
    try {
      const actorMap = JSON.parse(process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON ?? "{}") as Record<string, unknown>;
      const slackActors = actorMap && typeof actorMap === "object" && !Array.isArray(actorMap) ? actorMap.slack : undefined;
      slackActorMappingPresent = Boolean(slackActors && typeof slackActors === "object" && !Array.isArray(slackActors) && Object.keys(slackActors).length > 0);
    } catch {
      slackActorMappingPresent = false;
    }
    const prefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const fallbackOwners = opRepo
      ? await opRepo.listIntegrationFallbackOwners(ctx, req.params.projectId)
      : [...integrationFallbackOwners.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ provider: key.slice(prefix.length), ...value }));
    const reconnectHistory = opRepo
      ? await opRepo.listIntegrationReconnectHistory(ctx, req.params.projectId)
      : [...integrationReconnectHistory.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ provider: key.slice(prefix.length), ...value }));
    return {
      projectId: req.params.projectId,
      github: {
        state: systemSql && process.env.NOEMA_PG_BOSS === "1" ? "available" : "needs_configuration",
        privateRepoAuthConfigured: Boolean(process.env.GITHUB_TOKEN || (process.env.GITHUB_APP_ID && process.env.GITHUB_INSTALLATION_ID && process.env.GITHUB_APP_PRIVATE_KEY)),
        webhookConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET && githubMappings.length > 0),
        repositories: githubMappings,
        mainHeads: githubMainHeads.map((head) => ({ repository: head.repository, branch: "main", commitSha: head.commitSha })),
        recentJobs: githubJobs.map((row) => ({ jobId: String(row.id), owner: String(row.owner), repo: String(row.repo), ref: String(row.ref), state: String(row.state), retries: Number(row.retry_count ?? 0), createdAt: String(row.created_on), completedAt: row.completed_on ? String(row.completed_on) : null, result: row.output ?? null }))
      },
      saas: {
        state: systemSql && process.env.NANGO_URL && process.env.NANGO_SECRET_KEY && process.env.NOEMA_PG_BOSS === "1" ? "available" : "needs_configuration",
        recentJobs: saasJobs.map((row) => ({ jobId: String(row.id), provider: String(row.provider), connectionId: String(row.connection_id), state: String(row.state), retries: Number(row.retry_count ?? 0), createdAt: String(row.created_on), completedAt: row.completed_on ? String(row.completed_on) : null, result: row.output ?? null }))
      },
      notificationChannels,
      fallbackOwners,
      reconnectHistory,
      slackInteractiveApprovalConfigured: Boolean(process.env.NOEMA_WEBHOOK_SECRET_SLACK && slackActorMappingPresent)
    };
  });

  app.post("/v1/projects/:projectId/integrations/:provider/sync", {
    schema: {
      params: Type.Object({ projectId: Type.String(), provider: Type.String() }),
      body: Type.Object({ connectionId: Type.String({ minLength: 1, maxLength: 200 }), model: Type.Optional(Type.String({ maxLength: 100 })) })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const providers: SaasProvider[] = ["jira", "linear", "notion", "confluence", "figma", "sentry", "datadog", "hubspot", "salesforce", "slack", "gitlab", "bitbucket", "google-drive", "grafana", "teams"];
    if (!providers.includes(req.params.provider as SaasProvider)) throw new BrainError("BRAIN_ERR_CONFLICT", "Provedor SaaS não suportado.", 400);
    if (!process.env.NANGO_URL || !process.env.NANGO_SECRET_KEY || process.env.NOEMA_PG_BOSS !== "1") {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Configure NANGO_URL, NANGO_SECRET_KEY e pg-boss no servidor para sincronizar este provedor.", 503);
    }
    const jobId = await enqueueSaasIngestJob({
      tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
      provider: req.params.provider as SaasProvider, connectionId: req.body.connectionId, model: req.body.model
    });
    if (!jobId) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Banco de dados do worker não está configurado.", 503);
    await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project", actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "saas_ingestion_job", targetId: jobId, metadata: { provider: req.params.provider, connectionId: req.body.connectionId, model: req.body.model } });
    return { accepted: true, provider: req.params.provider, connectionId: req.body.connectionId, jobId };
  });

  app.post<{ Params: { provider: string }; Body: Record<string, unknown> }>(
    "/v1/ingestion/webhooks/:provider",
    async (req) => {
      const provider = req.params.provider.toLowerCase();
      if (provider === "github") {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
        if (!secret || !rawBody || !verifyGitHubSignature(rawBody, sig, secret)) {
          throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Assinatura GitHub Webhook inválida.", 401);
        }
        if ((req.headers["x-github-event"] as string | undefined) !== "push") {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Este webhook GitHub aceita somente eventos push.", 422);
        }
        const summary = parseGitHubPushEvent(req.body ?? {});
        const mapping = resolveGitHubRepoMapping(summary.repository);
        if (!mapping) throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Repositório ${summary.repository} não está mapeado para um projeto.`, 403);
        const repository = summary.repository.toLowerCase();
        const mainBranchPush = summary.ref === "refs/heads/main";
        const branch = summary.ref.slice("refs/heads/".length);
        const deletedRef = summary.commitSha === "0000000000000000000000000000000000000000";
        const beforeIsValid = /^[a-f0-9]{40}$/i.test(summary.beforeCommitSha) || summary.beforeCommitSha === "0000000000000000000000000000000000000000";
        if ((!deletedRef && !/^[a-f0-9]{40}$/i.test(summary.commitSha)) || !beforeIsValid || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(summary.ref)) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Payload push GitHub inválido ou sem commit/ref válido.", 422);
        }
        const auditContext: AuthContext = {
          tenantId: mapping.tenantId,
          actorId: "github-webhook",
          actorType: "system",
          roles: ["system"],
          allowedProjects: [mapping.projectId],
          allowedPolicies: [mapping.accessPolicyId]
        };
        let mainHeadUpdated = false;
        if (mainBranchPush) {
          if (deletedRef) {
            if (opRepo) {
              const deleted = await opRepo.deleteGitHubMainHead(auditContext, {
                projectId: mapping.projectId, repository, beforeCommitSha: summary.beforeCommitSha
              });
              mainHeadUpdated = deleted.length > 0;
            } else {
              const key = `${mapping.tenantId}:${mapping.projectId}:${repository}`;
              const existing = githubMainHeadMemory.get(key);
              mainHeadUpdated = Boolean(existing && existing.commitSha === summary.beforeCommitSha.toLowerCase());
              if (mainHeadUpdated) githubMainHeadMemory.delete(key);
            }
            return { accepted: true, provider: "github", deleted: true, repository: summary.repository, mainHeadUpdated };
          }
          if (opRepo) {
            const saved = await opRepo.upsertGitHubMainHead(auditContext, {
              projectId: mapping.projectId, repository, commitSha: summary.commitSha,
              accessPolicyId: mapping.accessPolicyId, beforeCommitSha: summary.beforeCommitSha
            });
            mainHeadUpdated = saved.length > 0;
          } else {
            const key = `${mapping.tenantId}:${mapping.projectId}:${repository}`;
            const existing = githubMainHeadMemory.get(key);
            if (!existing || existing.commitSha === summary.beforeCommitSha.toLowerCase()) {
              githubMainHeadMemory.set(key, { repository, commitSha: summary.commitSha.toLowerCase(), accessPolicyId: mapping.accessPolicyId });
              mainHeadUpdated = true;
            }
          }
          if (!mainHeadUpdated) {
            return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha, ignored: true, reason: "out_of_order_main_push", mainHeadUpdated: false };
          }
        } else if (opRepo) {
          if (deletedRef) {
            const deleted = await opRepo.deleteGitHubRefHead(auditContext, { projectId: mapping.projectId, repository, branch, beforeCommitSha: summary.beforeCommitSha });
            if (!deleted.length) return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, ignored: true, reason: "out_of_order_ref_delete" };
            return { accepted: true, provider: "github", deleted: true, repository: summary.repository, branch };
          }
          const saved = await opRepo.upsertGitHubRefHead(auditContext, { projectId: mapping.projectId, repository, branch, commitSha: summary.commitSha, accessPolicyId: mapping.accessPolicyId, beforeCommitSha: summary.beforeCommitSha });
          if (!saved.length) return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, ignored: true, reason: "out_of_order_ref_push" };
        } else if (deletedRef) {
          return { accepted: true, provider: "github", deleted: true, repository: summary.repository, mainHeadUpdated: false };
        }
        if (process.env.NOEMA_PG_BOSS !== "1") {
          throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Webhook GitHub exige o worker pg-boss ativo.", 503);
        }
        const [owner, repo] = summary.repository.split("/");
        const jobId = await enqueueGitHubJob({ ...mapping, owner: owner!, repo: repo!, ref: summary.commitSha, branch, beforeCommitSha: summary.beforeCommitSha });
        if (!jobId) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Banco de dados do worker não está configurado.", 503);
        await recordAudit(auditContext, {
          tenantId: mapping.tenantId,
          projectId: mapping.projectId,
          accessPolicyId: mapping.accessPolicyId,
          actorId: auditContext.actorId,
          actorType: auditContext.actorType,
          action: "create",
          targetType: "github_ingestion_job",
          targetId: jobId,
          metadata: { repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha }
        });
        return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha, jobId, mainHeadUpdated };
      }
      const item = handleSaasWebhook(provider as SaasProvider, req.body ?? {});
      assertSecretScanClean(scanForSecrets(`${item.title}\n${item.content}`), "Segredo detectado no payload do webhook");
      const originalContent = item.content;
      const originalTitle = item.title;
      const [sanitizedContent, sanitizedTitle] = await Promise.all([
        redactPiiWithAiWorker(item.content), redactPiiWithAiWorker(item.title)
      ]);
      item.content = sanitizedContent;
      item.title = sanitizedTitle;
      item.contentHash = createHash("sha256").update(`${sanitizedTitle}\n${sanitizedContent}`).digest("hex");
      await upsertKnowledgeItem({
        tenantId: item.tenantId,
        actorId: "saas-webhook",
        actorType: "system",
        roles: ["system"],
        allowedProjects: [item.projectId],
        allowedPolicies: [item.accessPolicyId]
      }, item);
      await recordAudit({ tenantId: item.tenantId, actorId: "saas-webhook", actorType: "system", roles: ["system"], allowedProjects: [item.projectId], allowedPolicies: [item.accessPolicyId] }, {
        tenantId: item.tenantId, projectId: item.projectId, accessPolicyId: item.accessPolicyId,
        actorId: "saas-webhook", actorType: "system", action: "create", targetType: "knowledge_item", targetId: item.id,
        metadata: { source: "saas_webhook", piiRedacted: sanitizedContent !== originalContent || sanitizedTitle !== originalTitle }
      });
      return { accepted: true, provider, itemId: item.id, trustLevel: item.trustLevel };
    }
  );

  // Eventos estruturados de integrações externas (mcp-and-api-spec.md §5 & Normativo 86-87)
  app.post<{
    Params: { provider: string };
    Body: {
      eventType?: string;
      projectId?: string;
      proposalId?: string;
      approved?: boolean;
      decision?: ApprovalDecision;
      proposalVersion?: number;
      comment?: string;
      externalUserId?: string;
      externalEventId?: string;
      taskId?: string;
      questionId?: string;
      response?: string;
      idempotencyKey?: string;
      runId?: string;
      commitSha?: string;
      repository?: string;
      executedAt?: string;
      results?: Array<{ testItemId: string; status: string; durationMs?: number }>;
      payload?: Record<string, unknown>;
    };
  }>("/v1/integrations/:provider/events", async (req) => {
    const provider = req.params.provider.toLowerCase();
    const webhookSecret =
      process.env[`NOEMA_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sigHeader =
        (req.headers["x-noema-signature-256"] as string | undefined) ??
        (req.headers["x-hub-signature-256"] as string | undefined);
      if (!verifyChannelWebhookSignature(JSON.stringify(req.body ?? {}), sigHeader, webhookSecret)) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Assinatura HMAC inválida para canal '${provider}'.`, 401);
      }
    }
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const body = req.body ?? {};
    if (body.eventType === "test.results") {
      if (!webhookSecret) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Resultados de CI '${provider}' requerem segredo HMAC configurado.`, 401);
      if (typeof body.projectId !== "string" || typeof body.externalUserId !== "string" || !body.externalUserId.trim() ||
          typeof body.runId !== "string" || !body.runId.trim() || typeof body.commitSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(body.commitSha) ||
          !Array.isArray(body.results) || body.results.length < 1 || body.results.length > 500) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resultados CI requerem projectId, externalUserId, runId, commitSha (40–64 hex) e 1–500 resultados.", 400);
      }
      assertProjectAccess(ctx, body.projectId);
      const serviceActor = mapExternalHumanActor(ctx, provider, body.externalUserId, body.projectId, "internal-project", "system");
      if (!serviceActor.roles.includes("ci-bot")) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Identidade externa precisa do papel ci-bot.", 403);
      await enforceOpa(serviceActor, { projectId: body.projectId, accessPolicyId: "internal-project", action: "write" });
      const configuredRepositories = configuredGitHubRepositories(serviceActor.tenantId, body.projectId);
      let repository = typeof body.repository === "string" ? body.repository.trim().toLowerCase() : undefined;
      if (repository) {
        const repositoryMapping = resolveGitHubRepoMapping(repository);
        if (!repositoryMapping || repositoryMapping.tenantId !== serviceActor.tenantId || repositoryMapping.projectId !== body.projectId) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Repositório CI '${repository}' não está mapeado para este projeto.`, 403);
        }
      } else if (configuredRepositories.length === 1) {
        repository = configuredRepositories[0];
      } else if (configuredRepositories.length > 1) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resultados CI de um projeto com vários repositórios precisam informar 'repository'.", 400);
      }
      const seen = new Set<string>();
      const normalized = [] as Array<{ testItemId: string; accessPolicyId: string; status: "passed" | "failed" | "skipped"; durationMs: number | null }>;
      for (const result of body.results as Array<Record<string, unknown>>) {
        if (!result || typeof result.testItemId !== "string" || !result.testItemId.trim() || seen.has(result.testItemId) ||
            !["passed", "failed", "skipped"].includes(String(result.status)) ||
            (result.durationMs !== undefined && (!Number.isInteger(result.durationMs) || Number(result.durationMs) < 0))) {
          throw new BrainError("BRAIN_ERR_CONFLICT", "Cada resultado deve ter testItemId único, status válido e durationMs inteiro não negativo.", 400);
        }
        seen.add(result.testItemId);
        const item = pgKnowledge ? await pgKnowledge.getItem(serviceActor, body.projectId, result.testItemId) : retrieval.getItem(serviceActor, body.projectId, result.testItemId);
        if (!item || (item.type !== "test" && !/\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(item.sourceUri))) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Arquivo de teste '${result.testItemId}' não encontrado.`, 404);
        await enforceOpa(serviceActor, { projectId: body.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
        normalized.push({ testItemId: item.id, accessPolicyId: item.accessPolicyId, status: result.status as "passed" | "failed" | "skipped", durationMs: result.durationMs === undefined ? null : Number(result.durationMs) });
      }
      const executedAt = typeof body.executedAt === "string" && Number.isFinite(Date.parse(body.executedAt)) ? new Date(body.executedAt) : new Date();
      let acceptedCount = 0;
      let duplicateCount = 0;
      if (opRepo) {
        ({ acceptedCount, duplicateCount } = await opRepo.recordTestExecutionResults(serviceActor, { projectId: body.projectId, provider, runId: body.runId, commitSha: body.commitSha.toLowerCase(), repository, receivedBy: serviceActor.actorId, executedAt, results: normalized }));
      } else {
        for (const result of normalized) {
          const key = `${serviceActor.tenantId}:${body.projectId}:${provider}:${body.runId}:${result.testItemId}`;
          const value = { testItemId: result.testItemId, accessPolicyId: result.accessPolicyId, commitSha: body.commitSha.toLowerCase(), repository, status: result.status, durationMs: result.durationMs, executedAt: executedAt.toISOString(), receivedBy: serviceActor.actorId };
          const existing = testExecutionMemory.get(key);
          if (existing && (existing.repository !== value.repository || existing.commitSha !== value.commitSha || existing.status !== value.status || existing.durationMs !== value.durationMs)) throw new BrainError("BRAIN_ERR_CONFLICT", `Execução '${body.runId}' já foi registrada com resultado diferente para '${result.testItemId}'.`, 409);
          if (existing) duplicateCount++;
          else { testExecutionMemory.set(key, value); acceptedCount++; }
        }
      }
      if (acceptedCount) await recordAudit(serviceActor, { tenantId: serviceActor.tenantId, projectId: body.projectId, accessPolicyId: "internal-project", actorId: serviceActor.actorId, actorType: "system", action: "create", targetType: "test_execution", targetId: body.runId, metadata: { provider, commitSha: body.commitSha, repository, acceptedCount } });
      return { accepted: true, provider, handled: "test.results", runId: body.runId, acceptedCount, passed: normalized.filter((r) => r.status === "passed").length, failed: normalized.filter((r) => r.status === "failed").length, skipped: normalized.filter((r) => r.status === "skipped").length, duplicateCount };
    }
    if (body.eventType === "runner.question.response") {
      if (!webhookSecret) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Resposta do Runner '${provider}' requer segredo HMAC configurado.`, 401);
      if (!body.projectId || !body.taskId || !body.questionId || !body.response?.trim() || !body.idempotencyKey?.trim() || !body.externalUserId?.trim()) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resposta do Runner requer projectId, taskId, questionId, response, idempotencyKey e externalUserId.", 400);
      }
      assertProjectAccess(ctx, body.projectId);
      const questions = opRepo
        ? await opRepo.listRunnerTaskQuestions(ctx, body.projectId, body.taskId)
        : runner.listQuestions(ctx, body.taskId);
      const question = questions.find((entry) => entry.questionId === body.questionId);
      if (!question) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${body.questionId}' não encontrada para a tarefa.`, 404);
      const responsePolicyId = "accessPolicyId" in question ? question.accessPolicyId : "internal-project";
      const responseCtx = mapExternalHumanActor(ctx, provider, body.externalUserId, body.projectId, responsePolicyId);
      await enforceOpa(responseCtx, { projectId: body.projectId, accessPolicyId: responsePolicyId, action: "write" });
      const responseResult = opRepo
        ? await opRepo.answerRunnerQuestion(responseCtx, {
            projectId: body.projectId, taskId: body.taskId, questionId: body.questionId,
            response: body.response, idempotencyKey: `${provider}:${body.idempotencyKey}`
          })
        : runner.answerQuestion(responseCtx, body.taskId, {
            questionId: body.questionId, response: body.response, idempotencyKey: `${provider}:${body.idempotencyKey}`
          });
      if (!responseResult.duplicate) await recordAudit(responseCtx, {
        tenantId: responseCtx.tenantId, projectId: body.projectId,
        accessPolicyId: responsePolicyId, actorId: responseCtx.actorId,
        actorType: "human", action: "update", targetType: "runner_task_question", targetId: body.questionId,
        metadata: { taskId: body.taskId, provider, externalUserId: body.externalUserId }
      });
      return {
        accepted: true, provider, handled: "runner.question.response",
        questionId: "questionId" in responseResult ? responseResult.questionId : responseResult.question.questionId,
        status: "queued", responseRecorded: true, duplicate: responseResult.duplicate
      };
    }
    if (body.eventType === "approval.decision" && body.projectId && body.proposalId) {
      if (!webhookSecret) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Callback de aprovação '${provider}' requer segredo HMAC configurado.`, 401);
      }
      const decision = body.decision ?? (body.approved === undefined ? undefined : body.approved ? "approve" : "reject");
      if (!decision) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer decision ou approved legado.", 400);
      }
      assertProjectAccess(ctx, body.projectId);
      if (ctx.actorType === "agent") {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Aprovação em canal externo exige identidade humana autenticada.", 403);
      }
      const item = pgKnowledge
        ? await pgKnowledge.getItem(ctx, body.projectId, body.proposalId)
        : retrieval.getItem(ctx, body.projectId, body.proposalId);
      if (!item) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${body.proposalId}' não encontrada.`, 404);
      }
      const externalUserId = body.externalUserId?.trim();
      if (!externalUserId) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Callback de aprovação requer externalUserId assinado pelo provedor.", 401);
      }
      const decisionCtx = mapExternalHumanActor(ctx, provider, externalUserId, body.projectId, item.accessPolicyId);
      if (!Number.isInteger(body.proposalVersion) || body.proposalVersion! < 1) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer proposalVersion inteiro e positivo.", 400);
      }
      await enforceOpa(decisionCtx, {
        projectId: body.projectId,
        accessPolicyId: item.accessPolicyId,
        action: "approve",
        domainId: item.domainId
      });
      const externalEventId = body.externalEventId?.trim();
      if (!externalEventId) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer externalEventId para deduplicação.", 400);
      }
      const eventHash = createHash("sha256").update(JSON.stringify({
        projectId: body.projectId,
        proposalId: body.proposalId,
        proposalVersion: body.proposalVersion,
        decision,
        comment: body.comment ?? "",
        actorId: decisionCtx.actorId
      })).digest("hex");
      const eventKey = `${decisionCtx.tenantId}:${provider}:${externalEventId}`;
      let cachedResponse: Record<string, unknown> | undefined;
      let eventClaim: "claimed" | "duplicate" | "in_progress" | "key_conflict";
      if (opRepo) {
        const claim = await opRepo.claimIntegrationEvent(decisionCtx, {
          provider,
          externalEventId,
          projectId: body.projectId,
          proposalId: body.proposalId,
          accessPolicyId: item.accessPolicyId,
          eventHash
        });
        eventClaim = claim.state;
        cachedResponse = claim.response;
      } else {
        const existing = integrationEventMemory.get(eventKey);
        if (!existing) {
          integrationEventMemory.set(eventKey, { eventHash });
          eventClaim = "claimed";
        } else if (existing.eventHash !== eventHash) {
          eventClaim = "key_conflict";
        } else if (existing.response) {
          eventClaim = "duplicate";
          cachedResponse = existing.response;
        } else {
          eventClaim = "in_progress";
        }
      }
      if (eventClaim === "duplicate" && cachedResponse) return { ...cachedResponse, duplicate: true };
      if (eventClaim === "key_conflict") {
        throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
      }
      if (eventClaim === "in_progress" || eventClaim === "duplicate") {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação ainda está sendo processado.", 409);
      }
      try {
      if (item.version !== body.proposalVersion) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de decidir.`, 409);
      }
      if (pgApprovals) {
        try {
          await pgApprovals.decide(decisionCtx, body.projectId, body.proposalId, decision, body.comment);
        } catch (err) {
          const code = (err as { code?: string } | undefined)?.code;
          if (code !== "BRAIN_ERR_NOT_FOUND") throw err;
        }
      } else if (approvals.hasRequest(decisionCtx, body.projectId, item.id)) {
        approvals.decide(decisionCtx, body.projectId, body.proposalId, decision, body.comment);
      }
      const updated = {
        ...item,
        status: decision === "approve" ? ("approved" as const) : decision === "reject" ? ("deprecated" as const) : item.status,
        isInferred: decision === "approve" ? false : item.isInferred,
        updatedAt: new Date().toISOString()
      };
      await upsertKnowledgeItem(decisionCtx, updated);
      await recordAudit(decisionCtx, {
        tenantId: ctx.tenantId,
        projectId: body.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: decisionCtx.actorId,
        actorType: decisionCtx.actorType,
        action: decision === "approve" ? "approve" : decision === "reject" ? "revoke" : "update",
        targetType: "integration_approval_event",
        targetId: item.id,
        metadata: { provider, externalEventId: body.externalEventId, externalUserId, decision, comment: body.comment }
      });
      const eventResponse = {
        accepted: true,
        provider,
        handled: "approval.decision",
        proposalId: item.id,
        status: decision === "request_changes" ? "changes_requested" : updated.status,
        knowledgeStatus: updated.status
      };
      if (opRepo) {
        await opRepo.completeIntegrationEvent(decisionCtx, { provider, externalEventId, response: eventResponse });
      } else {
        integrationEventMemory.set(eventKey, { eventHash, response: eventResponse });
      }
      return eventResponse;
      } catch (err) {
        try {
          if (opRepo) await opRepo.releaseIntegrationEvent(decisionCtx, provider, externalEventId);
          else integrationEventMemory.delete(eventKey);
        } catch {
          // Keep the original processing error; stale reservations are reclaimable after five minutes.
        }
        throw err;
      }
    }

    const item = handleSaasWebhook(provider as SaasProvider, body.payload ?? (body as Record<string, unknown>));
    assertSecretScanClean(scanForSecrets(`${item.title}\n${item.content}`), "Segredo detectado no evento de integração");
    assertProjectAccess(ctx, item.projectId);
    assertPolicyAccess(ctx, item.accessPolicyId);
    const originalContent = item.content;
    const originalTitle = item.title;
    const [sanitizedContent, sanitizedTitle] = await Promise.all([
      redactPiiWithAiWorker(item.content), redactPiiWithAiWorker(item.title)
    ]);
    item.content = sanitizedContent;
    item.title = sanitizedTitle;
    item.contentHash = createHash("sha256").update(`${sanitizedTitle}\n${sanitizedContent}`).digest("hex");
    await upsertKnowledgeItem(ctx, item);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId, projectId: item.projectId, accessPolicyId: item.accessPolicyId,
      actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "knowledge_item", targetId: item.id,
      metadata: { source: "saas_integration_event", piiRedacted: sanitizedContent !== originalContent || sanitizedTitle !== originalTitle }
    });
    return { accepted: true, provider, handled: "ingestion", itemId: item.id };
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/cross-service/contracts", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const projectIds = req.query.projectId ? [req.query.projectId] : undefined;
    if (req.query.projectId) assertProjectAccess(ctx, req.query.projectId);
    const contracts = pgCrossService
      ? await pgCrossService.getContracts(ctx, projectIds)
      : crossService.getContracts(ctx, projectIds);
    return { contracts };
  });

  const forwardInteractiveApprovalAction = async (
    provider: string,
    signingSecret: string,
    input: {
      projectId: string;
      proposalId: string;
      proposalVersion: number;
      decision: ApprovalDecision;
      externalUserId: string;
      externalEventId: string;
      comment?: string;
    }
  ) => {
    const integrationEvent = {
      eventType: "approval.decision",
      projectId: input.projectId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      decision: input.decision,
      externalUserId: input.externalUserId,
      externalEventId: input.externalEventId,
      ...(input.comment ? { comment: input.comment } : {})
    };
    const eventBody = JSON.stringify(integrationEvent);
    const eventSignature = createHmac("sha256", signingSecret).update(eventBody, "utf8").digest("hex");
    return app.inject({
      method: "POST",
      url: `/v1/integrations/${encodeURIComponent(provider)}/events`,
      headers: {
        authorization: `Bearer ${configuredApiKey}`,
        "content-type": "application/json",
        "x-noema-signature-256": `sha256=${eventSignature}`
      },
      payload: integrationEvent
    });
  };

  app.post<{ Body: { payload?: unknown } }>("/v1/integrations/slack/actions", async (req, reply) => {
    const signingSecret = process.env.NOEMA_WEBHOOK_SECRET_SLACK ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    if (!signingSecret || !rawBody || !verifySlackRequestSignature(rawBody, timestamp, signature, signingSecret)) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Assinatura Slack inválida ou expirada.", 401);
    }
    const payload = req.body?.payload as {
      type?: string;
      user?: { id?: string };
      actions?: Array<{ action_id?: string; action_ts?: string; value?: string }>;
    } | undefined;
    const action = payload?.actions?.[0];
    if (payload?.type !== "block_actions" || !payload.user?.id || !action?.action_id || !action.action_ts || !action.value) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Payload de ação Slack inválido.", 400);
    }
    const decisions: Record<string, ApprovalDecision> = {
      noema_approve: "approve",
      noema_reject: "reject",
      noema_request_changes: "request_changes"
    };
    const decision = decisions[action.action_id];
    if (!decision) throw new BrainError("BRAIN_ERR_CONFLICT", "Ação Slack desconhecida.", 400);
    let context: { projectId?: unknown; proposalId?: unknown; proposalVersion?: unknown };
    try {
      context = JSON.parse(action.value) as typeof context;
    } catch {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Contexto de aprovação Slack inválido.", 400);
    }
    if (typeof context.projectId !== "string" || typeof context.proposalId !== "string" ||
        !Number.isInteger(context.proposalVersion) || Number(context.proposalVersion) < 1) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A ação Slack não contém projeto, proposta e versão válidos.", 400);
    }
    const result = await forwardInteractiveApprovalAction("slack", signingSecret, {
      projectId: context.projectId,
      proposalId: context.proposalId,
      proposalVersion: Number(context.proposalVersion),
      decision,
      externalUserId: payload.user.id,
      externalEventId: `${payload.user.id}:${action.action_ts}`
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return reply.code(200).send({ response_type: "ephemeral", text: "O Noema não conseguiu concluir a ação. Confira o estado da proposta no Command Center." });
    }
    return reply.code(200).send({ response_type: "ephemeral", text: "Decisão registrada no Noema." });
  });

  app.post<{
    Params: { channel: string };
    Body: Record<string, unknown>;
  }>("/v1/integrations/:channel/actions", async (req, reply) => {
    const channel = req.params.channel.toLowerCase();
    if (!["teams", "jira", "clickup", "email"].includes(channel)) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Canal interativo '${req.params.channel}' não suportado.`, 404);
    }
    const envSecretName = `NOEMA_WEBHOOK_SECRET_${channel.toUpperCase()}`;
    const signingSecret = process.env[envSecretName] ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
    const signature = req.headers["x-noema-signature-256"] as string | undefined;
    if (!signingSecret || !rawBody || !verifyChannelWebhookSignature(rawBody, signature, signingSecret)) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Assinatura ${channel} inválida ou ausente.`, 401);
    }
    const normalized = parseChannelActionPayload(
      channel as "teams" | "jira" | "clickup" | "email",
      (req.body ?? {}) as Record<string, unknown>
    );
    if (!normalized) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Payload de ação ${channel} inválido.`, 400);
    }
    const result = await forwardInteractiveApprovalAction(channel, signingSecret, {
      projectId: normalized.projectId,
      proposalId: normalized.proposalId,
      proposalVersion: normalized.proposalVersion,
      decision: normalized.decision,
      externalUserId: normalized.externalUserId,
      externalEventId: normalized.externalEventId,
      comment: normalized.comment
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return reply.code(result.statusCode).send(result.json());
    }
    return reply.code(200).send({ accepted: true, channel, decision: normalized.decision, result: result.json() });
  });

  app.post<{ Params: { projectId: string; provider: string } }>(
    "/v1/projects/:projectId/integrations/:provider/reconnect",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const key = `${ctx.tenantId}:${req.params.projectId}:${req.params.provider}`;
      const nangoUrl = process.env.NANGO_BASE_URL;
      const nangoSecret = process.env.NANGO_SECRET_KEY;
      let status = "reconnect_queued_local";
      if (nangoUrl && nangoSecret) {
        try {
          const res = await fetch(`${nangoUrl.replace(/\/$/, "")}/connection/${encodeURIComponent(req.params.provider)}/reconnect`, {
            method: "POST",
            headers: { authorization: `Bearer ${nangoSecret}`, "content-type": "application/json" }
          });
          status = res.ok ? "reconnected" : `nango_http_${res.status}`;
        } catch {
          status = "nango_unreachable";
        }
      }
      const entry = opRepo
        ? await opRepo.recordIntegrationReconnect(ctx, req.params.projectId, req.params.provider, status)
        : (() => {
            const localEntry = { lastReconnectAt: new Date().toISOString(), status, actorId: ctx.actorId };
            integrationReconnectHistory.set(key, localEntry);
            return localEntry;
          })();
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "integration_reconnect",
        targetId: req.params.provider,
        metadata: { status }
      });
      return { provider: req.params.provider, ...entry };
    }
  );

  app.put<{ Params: { projectId: string; provider: string }; Body: { fallbackOwner: string } }>(
    "/v1/projects/:projectId/integrations/:provider/fallback-owner",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const fallbackOwner = req.body.fallbackOwner?.trim();
      if (!fallbackOwner) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "fallbackOwner não pode estar vazio.", 400);
      }
      const key = `${ctx.tenantId}:${req.params.projectId}:${req.params.provider}`;
      const entry = opRepo
        ? await opRepo.upsertIntegrationFallbackOwner(ctx, req.params.projectId, req.params.provider, fallbackOwner)
        : (() => {
            const localEntry = { fallbackOwner, updatedAt: new Date().toISOString(), updatedBy: ctx.actorId };
            integrationFallbackOwners.set(key, localEntry);
            return localEntry;
          })();
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "integration_fallback_owner",
        targetId: req.params.provider,
        metadata: { fallbackOwner }
      });
      return { provider: req.params.provider, ...entry };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/profile", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const items = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 500 });
    const countByPolicy = new Map<string, number>();
    for (const hit of items) {
      countByPolicy.set(hit.item.accessPolicyId, (countByPolicy.get(hit.item.accessPolicyId) ?? 0) + 1);
    }
    const policyCatalog = [
      {
        policyId: "public-org",
        description: "Conhecimento compartilhado em toda a organização.",
        authorized: ctx.allowedPolicies.includes("public-org"),
        itemCount: countByPolicy.get("public-org") ?? 0
      },
      {
        policyId: "internal-project",
        description: "Conhecimento interno padrão do projeto.",
        authorized: ctx.allowedPolicies.includes("internal-project"),
        itemCount: countByPolicy.get("internal-project") ?? 0
      },
      {
        policyId: "restricted-security",
        description: "Conhecimento restrito (PII, pagamentos, segurança crítica).",
        authorized: ctx.allowedPolicies.includes("restricted-security"),
        itemCount: countByPolicy.get("restricted-security") ?? 0
      }
    ];
    const savedPolicies = opRepo
      ? await opRepo.listCustomAccessPolicies(ctx, req.params.projectId)
      : [...customPolicyCatalog.entries()]
          .filter(([key]) => key.startsWith(`${ctx.tenantId}:${req.params.projectId}:`))
          .map(([, policy]) => policy);
    const customPolicies = savedPolicies.filter((p) => !policyCatalog.some((base) => base.policyId === p.policyId));
    const mergedCatalog = [
      ...policyCatalog.map((base) => {
        const override = savedPolicies.find((p) => p.policyId === base.policyId);
        return override ? { ...base, description: override.description, label: override.label, allowedRoles: override.allowedRoles } : base;
      }),
      ...customPolicies.map((p) => ({
        policyId: p.policyId,
        label: p.label,
        description: p.description,
        allowedRoles: p.allowedRoles,
        authorized: ctx.allowedPolicies.includes(p.policyId),
        itemCount: countByPolicy.get(p.policyId) ?? 0
      }))
    ];
    return {
      projectId: req.params.projectId,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      identitySource: ctx.actorId === "local-api-key" ? "local-api-key" : "oidc-claims",
      opaConfigured: Boolean(process.env.OPA_URL),
      keycloakAdminConfigured: Boolean(process.env.KEYCLOAK_ADMIN_URL),
      roles: ctx.roles,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies,
      policyCatalog: mergedCatalog,
      currentProjectAuthorized: true,
      managementAvailable: true,
      managementStorage: opRepo ? "postgres" : "process-memory",
      managementNote: `${opRepo ? "Alterações locais de acesso persistem em PostgreSQL. " : "Alterações locais de acesso ficam em memória e se perdem ao reiniciar. "}${process.env.KEYCLOAK_ADMIN_URL ? "Sincronização OIDC/Keycloak está configurada." : "Configure KEYCLOAK_ADMIN_URL para sincronização OIDC externa."}`
    };
  });

  const requireAccessAdmin = (ctx: AuthContext) => {
    if (!ctx.roles.some((r) => ["admin", "appsec"].includes(r))) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Gestão administrativa de acesso restrita a admin/appsec.", 403);
    }
  };

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/members", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    const prefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const members = opRepo
      ? await opRepo.listAccessMembers(ctx, req.params.projectId)
      : [...accessMembers.entries()].filter(([key]) => key.startsWith(prefix)).map(([, member]) => member);
    return { projectId: req.params.projectId, keycloakConfigured: Boolean(process.env.KEYCLOAK_ADMIN_URL), members };
  });

  app.put<{ Params: { projectId: string; actorId: string }; Body: { roles: string[]; allowedPolicies?: string[] } }>(
    "/v1/projects/:projectId/access/members/:actorId/roles",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (!Array.isArray(req.body.roles) || req.body.roles.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "roles deve ser uma lista não vazia.", 400);
      }
      let syncedWithKeycloak = false;
      if (process.env.KEYCLOAK_ADMIN_URL && process.env.KEYCLOAK_ADMIN_TOKEN) {
        try {
          const res = await fetch(`${process.env.KEYCLOAK_ADMIN_URL.replace(/\/$/, "")}/users/${encodeURIComponent(req.params.actorId)}/role-mappings/realm`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.KEYCLOAK_ADMIN_TOKEN}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(req.body.roles.map((name) => ({ name })))
          });
          syncedWithKeycloak = res.ok;
        } catch {
          syncedWithKeycloak = false;
        }
      }
      const record = {
        actorId: req.params.actorId,
        roles: [...new Set(req.body.roles)],
        allowedPolicies: req.body.allowedPolicies ? [...new Set(req.body.allowedPolicies)] : ["internal-project"],
        updatedAt: new Date().toISOString(),
        syncedWithKeycloak
      };
      if (opRepo) {
        await opRepo.saveAccessMember(ctx, req.params.projectId, record);
      } else {
        accessMembers.set(accessMemberKey(ctx, req.params.projectId, req.params.actorId), record);
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "access_member_roles",
        targetId: req.params.actorId,
        metadata: { roles: record.roles, allowedPolicies: record.allowedPolicies, syncedWithKeycloak }
      });
      return record;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/grants", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    const now = Date.now();
    const grants = opRepo
      ? await opRepo.listTemporaryAccessGrants(ctx, req.params.projectId, new Date(now))
      : [...temporaryGrants.values()].filter((g) =>
          g.tenantId === ctx.tenantId && g.projectId === req.params.projectId && Date.parse(g.expiresAt) > now
        );
    return { projectId: req.params.projectId, grants };
  });

  app.post<{
    Params: { projectId: string };
    Body: { actorId: string; roles?: string[]; policyIds?: string[]; ttlMinutes?: number };
  }>("/v1/projects/:projectId/access/grants", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const ttlMinutes = Math.min(10080, Math.max(5, Number(req.body.ttlMinutes ?? 60)));
    const grantId = `GRANT-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const grant = {
      grantId,
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      actorId: req.body.actorId,
      roles: req.body.roles ?? ["developer"],
      policyIds: req.body.policyIds ?? ["internal-project"],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
      grantedBy: ctx.actorId
    };
    const persisted = opRepo
      ? await opRepo.createTemporaryAccessGrant(ctx, {
          grantId, projectId: req.params.projectId, actorId: grant.actorId, roles: grant.roles,
          policyIds: grant.policyIds, expiresAt: new Date(grant.expiresAt), grantedBy: grant.grantedBy
        })
      : (temporaryGrants.set(grantId, grant), grant);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "temporary_access_grant",
      targetId: grantId,
      metadata: { actorId: grant.actorId, expiresAt: grant.expiresAt, roles: grant.roles, policyIds: grant.policyIds }
    });
    return { tenantId: ctx.tenantId, ...persisted };
  });

  app.delete<{ Params: { projectId: string; grantId: string } }>(
    "/v1/projects/:projectId/access/grants/:grantId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      const grant = temporaryGrants.get(req.params.grantId);
      const revoked = opRepo
        ? await opRepo.revokeTemporaryAccessGrant(ctx, req.params.projectId, req.params.grantId)
        : Boolean(grant && grant.tenantId === ctx.tenantId && grant.projectId === req.params.projectId && temporaryGrants.delete(req.params.grantId));
      if (!revoked) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Concessão '${req.params.grantId}' não encontrada.`, 404);
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "revoke",
        targetType: "temporary_access_grant",
        targetId: req.params.grantId
      });
      return { revoked: true, grantId: req.params.grantId };
    }
  );

  app.put<{ Params: { projectId: string; policyId: string }; Body: { label?: string; description: string; allowedRoles?: string[] } }>(
    "/v1/projects/:projectId/access/policies/:policyId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const entry = {
        policyId: req.params.policyId,
        label: req.body.label?.trim() || req.params.policyId,
        description: req.body.description.trim(),
        allowedRoles: req.body.allowedRoles ?? ["admin", "appsec", "tech-lead"],
        updatedAt: new Date().toISOString()
      };
      const savedEntry = opRepo
        ? await opRepo.upsertCustomAccessPolicy(ctx, req.params.projectId, entry)
        : (customPolicyCatalog.set(customPolicyKey(ctx, req.params.projectId, req.params.policyId), entry), entry);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "access_policy_catalog",
        targetId: req.params.policyId,
        metadata: { allowedRoles: savedEntry.allowedRoles }
      });
      return savedEntry;
    }
  );

  app.get<{ Querystring: { projectId?: string; limit?: string } }>("/v1/audit-logs", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    if (!ctx.roles.some((r) => ["admin", "appsec", "tech-lead"].includes(r))) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Acesso à trilha de auditoria restrito a admin/appsec.", 403);
    }
    const projectId = req.query.projectId;
    if (projectId) {
      assertProjectAccess(ctx, projectId);
      await enforceOpa(ctx, { projectId, accessPolicyId: "internal-project", action: "read" });
    }
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "100", 10) || 100));
    if (appPostgresClient && process.env.DATABASE_URL) {
      const rows = await appPostgresClient.withRlsTransaction(
        {
          tenantId: ctx.tenantId,
          allowedProjects: ctx.allowedProjects,
          allowedPolicies: ctx.allowedPolicies
        },
        async (client) => {
          if (projectId) {
            return await client`
              SELECT id, tenant_id, project_id, actor_id, actor_type, access_policy_id, action, target_type, target_id, created_at
              FROM audit_logs
              WHERE project_id = ${projectId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            ` as Array<Record<string, unknown>>;
          }
          return await client`
            SELECT id, tenant_id, project_id, actor_id, actor_type, access_policy_id, action, target_type, target_id, created_at
            FROM audit_logs
            ORDER BY created_at DESC
            LIMIT ${limit}
          ` as Array<Record<string, unknown>>;
        }
      );
      return { logs: rows.map(normalizeAuditLogRow) };
    }
    const memoryEvents = (auditLogger as (AuditLogger & { events?: Array<Record<string, unknown>> }) | undefined)?.events ?? [];
    const logs = memoryEvents
      .filter((event) => event.tenantId === ctx.tenantId && (!projectId || event.projectId === projectId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
    return { logs: logs.map(normalizeAuditLogRow) };
  });

  // Export .brainpack (Item 34)
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/brainpack", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 500 });
    const items = hits.map((h) => h.item);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "export",
      targetType: "brainpack",
      targetId: req.params.projectId,
      metadata: { itemCount: items.length }
    });
    return { format: "noema-brainpack-v1", projectId: req.params.projectId, exportedAt: new Date().toISOString(), items };
  });

  app.post<{ Params: { projectId: string }; Body: { items: Array<Parameters<typeof retrieval.upsertItem>[0]> } }>(
    "/v1/projects/:projectId/brainpack/import",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      let importedCount = 0;
      for (const item of req.body.items ?? []) {
        const scan = scanForSecrets(item.content);
        if (scan.engine === "unavailable") assertSecretScanClean(scan, "Gitleaks indisponível para importar Brainpack");
        if (!scan.clean) continue;
        assertPolicyAccess(ctx, item.accessPolicyId);
        await upsertKnowledgeItem(ctx, { ...item, tenantId: ctx.tenantId, projectId: req.params.projectId });
        importedCount += 1;
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "brainpack_import",
        targetId: req.params.projectId,
        metadata: { importedCount }
      });
      return { imported: true, importedCount };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/finops", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const items = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const modelUsage = await projectModelUsage(ctx, req.params.projectId);
    const estimatedLocalTokens = items.reduce((acc, h) => acc + Math.ceil(h.item.content.length / 4), 0);

    // Infrastructure & Energy cost estimation from telemetry
    const measuredTokens = modelUsage.byModel.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0);
    const totalTokens = measuredTokens > 0 ? measuredTokens : estimatedLocalTokens;
    const durationHours = (modelUsage.calls * 2) / 3600;
    const infraHourlyUsd = Number(process.env.NOEMA_INFRA_HOURLY_USD ?? "0.12");
    const kwhPerMillionTokens = Number(process.env.NOEMA_ENERGY_KWH_PER_MILLION_TOKENS ?? "0.45");
    const energyUsdPerKwh = Number(process.env.NOEMA_ENERGY_USD_PER_KWH ?? "0.15");
    const estimatedInfraUsd = Number((durationHours * infraHourlyUsd).toFixed(6));
    const estimatedEnergyKwh = Number(((totalTokens / 1_000_000) * kwhPerMillionTokens).toFixed(6));
    const estimatedEnergyUsd = Number((estimatedEnergyKwh * energyUsdPerKwh).toFixed(6));

    // Department quotas configured for this tenant/project
    const quotaPrefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const rawQuotas = opRepo
      ? await opRepo.listDepartmentFinopsQuotas(ctx, req.params.projectId)
      : [...departmentQuotas.entries()]
          .filter(([key]) => key.startsWith(quotaPrefix))
          .map(([, q]) => q);
    const quotas = rawQuotas.map((q) => {
      const usedTokens = measuredTokens;
      const usedUsd = Number(((modelUsage.providerCostUsd ?? 0) + estimatedInfraUsd + estimatedEnergyUsd).toFixed(6));
      const withinQuota = usedTokens <= q.monthlyTokenLimit && usedUsd <= q.monthlyUsdLimit;
      const downgradeModel = !withinQuota ? (("downgradeModel" in q ? q.downgradeModel : undefined) ?? process.env.NOEMA_FINOPS_DOWNGRADE_MODEL ?? "ollama:qwen2.5-coder:7b") : undefined;
      return {
        ...q,
        usedTokens,
        usedUsd,
        withinQuota,
        ...(downgradeModel ? { recommendedDowngradeModel: downgradeModel } : {})
      };
    });

    return {
      projectId: req.params.projectId,
      indexedItems: items.length,
      estimatedLocalTokens,
      estimatedMonthlySaasSavingsUsd: null,
      costTrackingAvailable: modelUsage.modelUsageAvailable && modelUsage.providerCostUsd !== null,
      actualProviderUsageAvailable: modelUsage.modelUsageAvailable,
      actualProviderCostUsd: modelUsage.providerCostUsd,
      modelUsage,
      infrastructureEstimate: {
        basis: "telemetry_derived",
        computeCostUsd: estimatedInfraUsd,
        energyKwh: estimatedEnergyKwh,
        energyCostUsd: estimatedEnergyUsd,
        totalInfraAndEnergyUsd: Number((estimatedInfraUsd + estimatedEnergyUsd).toFixed(6))
      },
      departmentQuotas: quotas,
      costTrackingNote: modelUsage.modelUsageAvailable
        ? "Tokens e custo do provedor agregados por execução; custos de infraestrutura e energia estimados a partir da telemetria de duração/tokens."
        : "Ainda não há execuções de modelo com métricas persistidas neste projeto. Estimativas de infra/energia usam tokens indexados como base.",
      pgOperationalActive: Boolean(opRepo),
      pgTemporalActive: Boolean(pgTemporal)
    };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/finops/quotas", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const prefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const quotas = opRepo
      ? await opRepo.listDepartmentFinopsQuotas(ctx, req.params.projectId)
      : [...departmentQuotas.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, q]) => q);
    return { projectId: req.params.projectId, quotas };
  });

  app.put<{
    Params: { projectId: string };
    Body: { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; downgradeModel?: string };
  }>("/v1/projects/:projectId/finops/quotas", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const department = req.body.department?.trim();
    if (!department || !Number.isFinite(req.body.monthlyTokenLimit) || !Number.isFinite(req.body.monthlyUsdLimit)) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Departamento e limites de cota inválidos.", 400);
    }
    const monthlyTokenLimit = Math.max(0, Math.floor(req.body.monthlyTokenLimit));
    const monthlyUsdLimit = Math.max(0, Number(req.body.monthlyUsdLimit));
    const entry = opRepo
      ? await opRepo.upsertDepartmentFinopsQuota(ctx, req.params.projectId, {
          department,
          monthlyTokenLimit,
          monthlyUsdLimit,
          downgradeModel: req.body.downgradeModel?.trim() || undefined
        })
      : (() => {
          const key = `${ctx.tenantId}:${req.params.projectId}:${department}`;
          const localEntry = {
            department,
            monthlyTokenLimit,
            monthlyUsdLimit,
            downgradeModel: req.body.downgradeModel?.trim() || undefined,
            updatedAt: new Date().toISOString()
          };
          departmentQuotas.set(key, localEntry);
          return localEntry;
        })();
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "update",
      targetType: "finops_department_quota",
      targetId: department,
      metadata: entry
    });
    return entry;
  });

  app.get<{ Params: { projectId: string }; Querystring: { domain?: string; stack?: string; crossProject?: string } }>(
    "/v1/projects/:projectId/scaffold/recommendations",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const domain = req.query.domain?.trim().toLowerCase() ?? "";
      const stack = req.query.stack?.trim().toLowerCase() ?? "";
      const includeCrossProject = req.query.crossProject === "true" || req.query.crossProject === "1";
      const stackTerms = stack === "python" ? ["python", "pyproject"] : stack ? ["node", "typescript", "node-ts"] : [];
      const query = [domain, ...stackTerms].filter(Boolean).join(" ");
      const targetProjects = new Set<string>([req.params.projectId]);
      if (includeCrossProject) {
        for (const p of ctx.allowedProjects) {
          if (p !== "*") targetProjects.add(p);
        }
        if (appPostgresClient && process.env.DATABASE_URL) {
          const rows = await appPostgresClient.withRlsTransaction(
            { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
            async (client) =>
              (await client`SELECT id FROM projects WHERE tenant_id = ${ctx.tenantId} LIMIT 50`) as Array<{ id: string }>
          );
          for (const row of rows) targetProjects.add(row.id);
        }
      }
      const allHits = [];
      for (const projId of targetProjects) {
        const projectHits = await queryAwareRetrieval.search(ctx, { projectId: projId, query, limit: 100 });
        allHits.push(...projectHits);
      }
      const seenIds = new Set<string>();
      const recommendations = allHits
        .filter(({ item }) => {
          if (seenIds.has(`${item.projectId}:${item.id}`)) return false;
          seenIds.add(`${item.projectId}:${item.id}`);
          return item.type === "architecture_decision" && item.status === "approved" && item.sourceOrigin === "internal" && item.trustLevel === "verified" && !item.isInferred;
        })
        .map((hit) => {
          const item = hit.item;
          const haystack = `${item.title} ${item.summary ?? ""} ${item.content} ${item.tags.join(" ")} ${String(item.metadata?.domain ?? "")}`.toLowerCase();
          const matchReasons = [
            ...(domain && haystack.includes(domain) ? [`domain:${domain}`] : []),
            ...(stackTerms.some((term) => haystack.includes(term)) ? [`stack:${stack}`] : []),
            ...(item.projectId !== req.params.projectId ? [`cross-project:${item.projectId}`] : [])
          ];
          return { item, matchReasons, score: hit.score };
        })
        .filter((entry) => entry.matchReasons.some((r) => !r.startsWith("cross-project:")))
        .sort((a, b) => {
          const aSame = a.item.projectId === req.params.projectId ? 1 : 0;
          const bSame = b.item.projectId === req.params.projectId ? 1 : 0;
          return b.matchReasons.length - a.matchReasons.length || bSame - aSame || b.score - a.score;
        })
        .slice(0, 8)
        .map(({ item, matchReasons, score }) => ({
          id: item.id,
          sourceProjectId: item.projectId,
          title: item.title,
          summary: (item.summary ?? item.content).slice(0, 360),
          sourceUri: item.sourceUri,
          sourceVersion: item.sourceVersion,
          status: item.status,
          sourceOrigin: item.sourceOrigin,
          matchReasons,
          score
        }));
      return {
        projectId: req.params.projectId,
        crossProject: includeCrossProject,
        domain: domain || null,
        stack: stack || null,
        recommendations,
        note: recommendations.length > 0
          ? includeCrossProject
            ? "Recomendações derivadas de ADRs internos aprovados e verificados (projeto atual + projetos autorizados)."
            : "Recomendações derivadas somente de ADRs internos aprovados e verificados."
          : "Nenhum ADR aprovado e verificado correspondeu ao domínio/stack informado; não foi inferido um padrão."
      };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      serviceName: string;
      domain?: string;
      objective?: string;
      criticality?: "low" | "medium" | "high" | "critical";
      stack?: "node-ts" | "python";
      communication?: "sync" | "events";
      handlesPii?: boolean;
      handlesPayments?: boolean;
      appliedAdrIds?: string[];
    };
  }>("/v1/projects/:projectId/scaffold/register", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const serviceSlug = req.body.serviceName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
    if (!serviceSlug) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Nome do serviço inválido para registro.", 400);
    }
    const handlesPii = Boolean(req.body.handlesPii);
    const handlesPayments = Boolean(req.body.handlesPayments);
    const criticality = req.body.criticality ?? "medium";
    const accessPolicyId = handlesPii || handlesPayments || criticality === "critical" ? "restricted-security" : "internal-project";
    assertPolicyAccess(ctx, accessPolicyId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId, action: "write" });
    const domain = req.body.domain?.trim() || "general";
    const objective = req.body.objective?.trim() || `Serviço ${serviceSlug}`;
    const stack = req.body.stack ?? "node-ts";
    const communication = req.body.communication ?? "sync";
    const appliedAdrIds = Array.isArray(req.body.appliedAdrIds) ? req.body.appliedAdrIds.filter(Boolean) : [];
    const content = [
      `# Serviço ${serviceSlug}`,
      "",
      objective,
      "",
      `- Domínio: ${domain}`,
      `- Stack: ${stack}`,
      `- Comunicação: ${communication}`,
      `- Criticidade: ${criticality}`,
      `- PII: ${handlesPii ? "sim" : "não"}`,
      `- Pagamentos: ${handlesPayments ? "sim" : "não"}`,
      ...(appliedAdrIds.length > 0 ? [`- ADRs aplicadas: ${appliedAdrIds.join(", ")}`] : [])
    ].join("\n");
    const scan = scanForSecrets(content);
    assertSecretScanClean(scan, "Segredo detectado ao registrar serviço scaffoldado");
    const itemId = `SVC-${serviceSlug.toUpperCase()}`;
    const sourceUri = `.brain/03-architecture/services/${serviceSlug}.md`;
    const now = new Date().toISOString();
    const contentHash = createHash("sha256").update(content).digest("hex");
    await upsertKnowledgeItem(ctx, {
      id: itemId,
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      type: "service",
      domainId: 3,
      title: `Serviço: ${serviceSlug}`,
      summary: objective.slice(0, 200),
      content,
      status: "draft",
      trustLevel: "verified",
      confidence: 1,
      isInferred: false,
      sourceOrigin: "internal",
      sourceKind: "git",
      sourceId: itemId,
      sourceUri,
      sourceVersion: "scaffold-v1",
      version: 1,
      contentHash,
      accessPolicyId,
      tags: ["scaffold", domain, stack, communication],
      metadata: { serviceSlug, domain, criticality, stack, communication, handlesPii, handlesPayments, appliedAdrIds },
      relatedIds: appliedAdrIds,
      validFrom: now,
      createdAt: now,
      updatedAt: now
    });
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "scaffold_service",
      targetId: itemId,
      metadata: { serviceSlug, domain, stack, appliedAdrIds }
    });
    return { registered: true, projectId: req.params.projectId, itemId, serviceSlug, accessPolicyId, sourceUri };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/operations/overview", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const items = hits.map((hit) => hit.item);
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const verifiedTests = evidence.verifiedTests;
    const health = projectHealth(items, verifiedTests);
    const queueConfigured = Boolean(ownedSystemSqlClient && process.env.NOEMA_PG_BOSS === "1");
    let queueCounts: Array<{ queue: string; state: string; count: number; latestAt: string | null }> = [];
    let recentFailures: Array<{ jobId: string; queue: string; failedAt: string; retries: number; errorSummary: string | null }> = [];
    if (queueConfigured && ownedSystemSqlClient) {
      const rows = await ownedSystemSqlClient<Array<Record<string, unknown>>>`
        SELECT name, state, COUNT(*)::int AS count, MAX(created_on) AS latest_at
        FROM pgboss.job
        WHERE data->>'tenantId' = ${ctx.tenantId}
          AND data->>'projectId' = ${req.params.projectId}
          AND created_on >= now() - interval '24 hours'
        GROUP BY name, state
        ORDER BY name, state
      `;
      queueCounts = rows.map((row) => ({
        queue: String(row.name), state: String(row.state), count: Number(row.count),
        latestAt: row.latest_at ? String(row.latest_at) : null
      }));
      const failures = await ownedSystemSqlClient<Array<Record<string, unknown>>>`
        SELECT id, name, created_on, retry_count, output
        FROM pgboss.job
        WHERE data->>'tenantId' = ${ctx.tenantId}
          AND data->>'projectId' = ${req.params.projectId}
          AND state = 'failed'
          AND created_on >= now() - interval '24 hours'
        ORDER BY created_on DESC
        LIMIT 10
      `;
      recentFailures = failures.map((row) => {
        const rawOutput = row.output;
        let errorSummary: string | null = null;
        if (rawOutput && typeof rawOutput === "object") {
          const msg = (rawOutput as { message?: unknown; error?: unknown }).message ?? (rawOutput as { error?: unknown }).error;
          if (typeof msg === "string" && msg.trim().length > 0) errorSummary = msg.trim().slice(0, 200);
        } else if (typeof rawOutput === "string" && rawOutput.trim().length > 0) {
          errorSummary = rawOutput.trim().slice(0, 200);
        }
        return {
          jobId: String(row.id),
          queue: String(row.name),
          failedAt: String(row.created_on),
          retries: Number(row.retry_count ?? 0),
          errorSummary
        };
      });
    }
    const qaCoverage = buildBusinessRuleTestCoverageMatrix(items, [], {
      linkedTestsByRule: evidence.linkedTestsByRule,
      testItemsById: evidence.testItemsById,
      requireMainHead: evidence.requireMainHead,
      requireRepositoryAssociation: evidence.requireRepositoryAssociation,
      mainHeadByRepository: evidence.mainHeadByRepository,
      testResults: evidence.testExecutionResults
    });
    const modelUsage = await projectModelUsage(ctx, req.params.projectId);
    return {
      projectId: req.params.projectId,
      generatedAt: new Date().toISOString(),
      service: { api: "ok", postgresOperational: Boolean(opRepo), pgBoss: queueConfigured ? "available" : "not_configured" },
      health: {
        score: health.healthScore,
        activeItems: items.length,
        untestedRules: health.untestedRuleIds,
        staleItems: health.staleItemIds,
        gitConnectorConflicts: health.gitVsConnectorConflicts
      },
      quality: { qaCoveragePercent: qaCoverage.coveragePercent, rules: qaCoverage.rows },
      queues: { windowHours: 24, counts: queueCounts, recentFailures },
      telemetry: { apiLatencyMs: computeLatencyTelemetry() },
      finops: {
        estimatedIndexedTokens: items.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0),
        tokenEstimateMethod: "character_count_divided_by_four",
        actualProviderUsageAvailable: modelUsage.modelUsageAvailable,
        actualCostUsd: modelUsage.providerCostUsd,
        modelUsage,
        note: modelUsage.modelUsageAvailable
          ? "Uso do modelo medido vem de contadores do provedor. Custo de infraestrutura local não está incluído."
          : "Tokens indexados são uma estimativa de conteúdo, não uso do provedor. Configure NOEMA_RUNNER_MODEL_EXECUTION=ollama; custos de infraestrutura local não são medidos."
      }
    };
  });

  app.post<{ Params: { projectId: string; jobId: string } }>(
    "/v1/projects/:projectId/operations/jobs/:jobId/retry",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (!ownedSystemSqlClient || process.env.NOEMA_PG_BOSS !== "1") {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "pg-boss não está configurado neste ambiente.", 503);
      }
      const rows = await ownedSystemSqlClient<Array<{ id: string; name: string; state: string }>>`
        SELECT id, name, state
        FROM pgboss.job
        WHERE id = ${req.params.jobId}
          AND data->>'tenantId' = ${ctx.tenantId}
          AND data->>'projectId' = ${req.params.projectId}
        LIMIT 1
      `;
      const job = rows[0];
      if (!job) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Job '${req.params.jobId}' não encontrado neste projeto.`, 404);
      }
      if (job.state !== "failed") {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Somente jobs em estado 'failed' podem ser reenfileirados (atual: ${job.state}).`, 409);
      }
      const bossUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!bossUrl) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "DATABASE_SYSTEM_URL ou DATABASE_URL é obrigatório para reenfileirar jobs.", 503);
      }
      const boss = new PgBoss(bossUrl);
      await boss.start();
      try {
        await boss.retry(job.name, job.id);
      } finally {
        await boss.stop();
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "pgboss_job_retry",
        targetId: job.id,
        metadata: { queue: job.name }
      });
      return { retried: true, jobId: job.id, queue: job.name, projectId: req.params.projectId };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { epicDescription: string; targetFiles?: string[]; impactedRuleIds?: string[] };
  }>("/v1/projects/:projectId/tasks/plan", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
    if (!req.body.epicDescription?.trim()) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Descrição do épico é obrigatória para planejar tarefas.", 400);
    }
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: req.body.epicDescription, limit: 150 });
    const items = hits.map((h) => h.item);
    const rules = items.filter((item) => item.type === "business_rule");
    const requirements = items.filter((item) => item.type === "requirement");
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const health = projectHealth(items, evidence.verifiedTests);
    const tasks = planAutonomousTasks(req.body.epicDescription.trim(), rules, {
      requirements,
      impactedRuleIds: req.body.impactedRuleIds,
      uncoveredRuleIds: health.untestedRuleIds,
      targetFiles: req.body.targetFiles
    });
    return {
      projectId: req.params.projectId,
      epicDescription: req.body.epicDescription.trim(),
      evaluatedRulesCount: rules.length,
      uncoveredRuleIds: health.untestedRuleIds,
      tasks
    };
  });

  app.post<{
    Params: { projectId: string };
    Body: { changedFiles: string[]; diffSummary?: string; submitDrafts?: boolean };
  }>("/v1/projects/:projectId/living-docs/suggest", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const changedFiles = (req.body.changedFiles ?? []).map((f) => f.trim()).filter(Boolean);
    if (changedFiles.length === 0) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Informe ao menos um caminho de arquivo alterado.", 400);
    }
    await enforceOpa(ctx, {
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      action: req.body.submitDrafts ? "write" : "read"
    });
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 300 });
    const items = hits.map((h) => h.item);
    const drafts = orchestrateLivingDocDrafts({
      changedFiles,
      items,
      diffSummary: req.body.diffSummary,
      authorId: ctx.actorId
    });
    const submittedProposalIds: string[] = [];
    if (req.body.submitDrafts && drafts.length > 0) {
      const scan = scanForSecrets(drafts.map((d) => d.proposedContent).join("\n"));
      assertSecretScanClean(scan, "Segredo detectado em sugestão de Living Documentation");
      const now = new Date().toISOString();
      for (const draft of drafts) {
        const targetItem = items.find((i) => i.id === draft.targetItemId);
        const accessPolicyId = targetItem?.accessPolicyId ?? "internal-project";
        assertPolicyAccess(ctx, accessPolicyId);
        const proposalItem: KnowledgeItem = {
          id: draft.id,
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          type: "document",
          domainId: targetItem?.domainId ?? 3,
          title: draft.title,
          summary: draft.reason,
          content: draft.proposedContent,
          status: "draft",
          trustLevel: "self_authored",
          confidence: 0.7,
          isInferred: true,
          sourceOrigin: "internal",
          sourceKind: "git",
          sourceId: draft.id,
          sourceUri: draft.targetUri,
          sourceVersion: "living-doc-v1",
          version: 1,
          contentHash: createHash("sha256").update(draft.proposedContent).digest("hex"),
          accessPolicyId,
          tags: ["living-doc", "draft"],
          metadata: { matchedFiles: draft.matchedFiles, targetItemId: draft.targetItemId },
          relatedIds: [draft.targetItemId],
          validFrom: now,
          createdAt: now,
          updatedAt: now
        };
        await upsertKnowledgeItem(ctx, proposalItem);
        const reqSubmitted = pgApprovals
          ? await pgApprovals.submit(ctx, proposalItem)
          : approvals.submit(ctx, proposalItem);
        submittedProposalIds.push(reqSubmitted.proposalId);
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "living_doc_proposals",
        targetId: req.params.projectId,
        metadata: { submittedCount: submittedProposalIds.length, changedFiles }
      });
    }
    return {
      projectId: req.params.projectId,
      changedFiles,
      drafts,
      submittedCount: submittedProposalIds.length,
      submittedProposalIds
    };
  });

  return app;
}

if (process.argv[1]?.endsWith("server.js")) {
  initTelemetry("noema-api");
  const port = Number(process.env.PORT ?? 3333);
  const app = buildApp();
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
