import Fastify from "fastify";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import PgBoss from "pg-boss";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  assertPolicyAccess,
  assertProjectAccess,
  authenticateRequest,
  canApproveDomain,
  evaluateOpaPolicy,
  type AuthContext
} from "@noema/auth";
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
import { createRealtimeHub } from "./realtime.js";
import { registerAccessProfileRoutes } from "./routes/access-profile.js";
import { registerAccessRbacRoutes } from "./routes/access-rbac.js";
import { registerBrainpackRoutes } from "./routes/brainpack.js";
import { registerFinopsAuditRoutes } from "./routes/finops-audit.js";
import { registerHandoffsHooksRoutes } from "./routes/handoffs-hooks.js";
import { registerIngestContextRoutes } from "./routes/ingest-context.js";
import { registerIngestDocumentRoutes } from "./routes/ingest-document.js";
import { registerIntegrationsRoutes } from "./routes/integrations.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { registerPrivacyEnterpriseRoutes } from "./routes/privacy-enterprise.js";
import { registerProjectsKnowledgeRoutes } from "./routes/projects-knowledge.js";
import { registerProposalsRoutes } from "./routes/proposals.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerRunnerRoutes } from "./routes/runner.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { createApiRuntimeStores } from "./runtime/stores.js";
import { registerRbacGuard } from "./security/rbac.js";
import { createProjectMetricsService } from "./services/project-metrics.js";
import {
  assertSecretScanClean,
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BASE64_CHARS,
  MAX_DOCUMENT_BYTES,
  parseDocumentWithAiWorker,
  redactPiiWithAiWorker,
  rerankWithAiWorker
} from "./services/ai-worker.js";
import {
  configuredGitHubRepositories,
  configuredPolicyScope,
  configuredProjectScope,
  configuredWorkspaceRoot,
  enqueueApprovalReminders,
  enqueueRemoteGitIngestJob,
  mapExternalHumanActor,
  normalizeAuditLogRow,
  resolveGitHubRepoMapping
} from "./services/jobs.js";
export { redactPiiWithAiWorker };
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
  const realtime = createRealtimeHub({ server: app.server, allowedCorsOrigin });
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
  const {
    appPostgresClient,
    ownedSystemSqlClient,
    systemKnowledgeClient,
    graph,
    retrieval,
    handoffs,
    runner,
    approvals,
    temporal,
    crossService,
    policyEpochByProject,
    pgGraph,
    pgRetrieval,
    queryAwareRetrieval,
    contextEngine,
    pgMemory,
    pgKnowledge,
    pgApprovals,
    opRepo,
    pgTemporal,
    pgCrossService,
    upsertKnowledgeItem,
    departmentQuotas,
    accessMembers,
    temporaryGrants,
    customPolicyCatalog,
    shreddedSubjectKeys,
    registeredProjects,
    integrationEventMemory,
    testExecutionMemory,
    githubMainHeadMemory,
    accessMemberKey,
    customPolicyKey,
    enforceOpa,
    recordAudit,
    authenticateProjectRequest,
    close: closeStores
  } = createApiRuntimeStores({
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    auditLogger,
    createAppClient,
    createSystemClient,
    probeEmbeddingProvider,
    queryEmbeddingProvider
  });

  app.addHook("onClose", async () => {
    await closeStores();
    await shutdownTelemetry();
  });

  registerRbacGuard(app, {
    authenticateProjectRequest,
    configuredApiKey,
    allowedProjects,
    allowedPolicies
  });
  registerRealtimeRoutes(app, {
    realtime,
    authenticateProjectRequest,
    configuredApiKey,
    allowedProjects,
    allowedPolicies
  });
  registerAccessRbacRoutes({
    app,
    authenticateProjectRequest,
    recordAudit,
    opRepo
  });

  const { projectVerifiedTests, projectHealth, projectModelUsage } = createProjectMetricsService({
    appPostgresClient,
    opRepo,
    pgGraph,
    graph,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    githubMainHeadMemory,
    testExecutionMemory
  });

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

  const deploymentMode = process.env.NOEMA_DEPLOYMENT_MODE === "cloud" ? "cloud" : "local";

  const { getDeveloperProfile } = registerSystemRoutes(app, {
    deploymentMode,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    recordAudit,
    opRepo,
    pgGraph,
    graph,
    queryAwareRetrieval,
    pgRetrieval,
    contextEngine,
    handoffs,
    runner,
    pgMemory,
    pgKnowledge,
    pgCrossService,
    crossService,
    pgApprovals,
    approvals,
    registeredProjects
  });

  registerIngestContextRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    probeEmbeddingProvider,
    getDeveloperProfile,
    graph,
    pgGraph,
    contextEngine,
    pgMemory,
    opRepo
  });
  registerRunnerRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    runner,
    opRepo
  });

  registerHandoffsHooksRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    getDeveloperProfile,
    handoffs,
    opRepo
  });
  registerIngestDocumentRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    probeEmbeddingProvider
  });

  registerSyncRoutes(app, {
    authenticateProjectRequest,
    recordAudit,
    upsertKnowledgeItem,
    queryAwareRetrieval,
    opRepo,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    pgApprovals,
    approvals,
    policyEpochByProject
  });

  registerProposalsRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    integrationEventMemory,
    opRepo,
    pgApprovals,
    approvals,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    pgGraph,
    graph,
    runner,
    auditLogger
  });

  registerPrivacyEnterpriseRoutes(app, {
    authenticateProjectRequest,
    recordAudit,
    queryAwareRetrieval,
    projectVerifiedTests,
    projectHealth,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    systemKnowledgeClient,
    pgRetrieval,
    opRepo,
    pgTemporal,
    temporal,
    pgCrossService,
    crossService,
    shreddedSubjectKeys
  });

  registerProjectsKnowledgeRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    queryAwareRetrieval,
    projectVerifiedTests,
    projectHealth,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    registeredProjects,
    opRepo,
    appPostgresClient,
    pgRetrieval,
    retrieval,
    pgKnowledge,
    pgGraph,
    graph,
    pgApprovals,
    approvals,
    runner,
    pgCrossService,
    crossService
  });

  registerIntegrationsRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    ownedSystemSqlClient,
    opRepo,
    pgCrossService,
    crossService,
    githubMainHeadMemory
  });

  registerWebhookRoutes(app, {
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    opRepo,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    pgApprovals,
    approvals,
    runner,
    enqueueGitHubJob,
    githubMainHeadMemory,
    testExecutionMemory,
    integrationEventMemory
  });

  registerAccessProfileRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    queryAwareRetrieval,
    opRepo,
    customPolicyCatalog,
    customPolicyKey,
    accessMembers,
    accessMemberKey,
    temporaryGrants
  });
  registerBrainpackRoutes(app, {
    authenticateProjectRequest,
    recordAudit,
    queryAwareRetrieval,
    upsertKnowledgeItem
  });
  registerFinopsAuditRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    queryAwareRetrieval,
    projectModelUsage,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    appPostgresClient,
    auditLogger,
    opRepo,
    pgTemporal,
    departmentQuotas
  });

  registerOperationsRoutes(app, {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    queryAwareRetrieval,
    upsertKnowledgeItem,
    projectVerifiedTests,
    projectHealth,
    projectModelUsage,
    computeLatencyTelemetry,
    appPostgresClient,
    ownedSystemSqlClient,
    opRepo,
    pgApprovals,
    approvals
  });

  return app;
}

if (process.argv[1]?.endsWith("server.js")) {
  initTelemetry("noema-api");
  const port = Number(process.env.PORT ?? 3333);
  const deploymentMode = process.env.NOEMA_DEPLOYMENT_MODE === "cloud" ? "cloud" : "local";
  const app = buildApp();
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(
      JSON.stringify({
        service: "noema-api",
        deploymentMode,
        description:
          deploymentMode === "cloud"
            ? "Hub compartilhado em nuvem/time (MCP HTTP + REST)"
            : "Instância local/solo na máquina ou rede (MCP + Edge/Local)",
        port
      })
    );
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
