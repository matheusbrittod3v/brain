import { HandoffStore } from "@noema/agent-handoff";
import { BrainRunnerQueue } from "@noema/agent-runner";
import { ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import {
  createPostgresAuditLogger,
  type AppPostgresClient,
  type AuditLogger,
  type RlsSessionContext
} from "@noema/audit-engine";
import { assertProjectAccess, authenticateRequest, evaluateOpaPolicy, type AuthContext } from "@noema/auth";
import type { HumanOpsChannel } from "@noema/connector-saas";
import { ContextEngine } from "@noema/context-engine";
import { BrainError, type KnowledgeItem } from "@noema/core";
import { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import { createDatabaseClient, PgOperationalRepository } from "@noema/database";
import { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import { PostgresKnowledgeRepository, type SystemKnowledgeSqlClient } from "@noema/knowledge";
import { PostgresMemoryManager } from "@noema/memory";
import {
  HybridRetrievalEngine,
  PostgresRetrievalEngine,
  ValkeyRetrievalCache,
  type AsyncRetrievalEngine,
  type SearchQuery
} from "@noema/retrieval";
import { TemporalKnowledgeEngine, PgTemporalKnowledgeRepository } from "@noema/temporal-knowledge";
import type { OllamaEmbeddingProviderStatus } from "@noema/worker";
import {
  defaultNotificationPreferences,
  nextNotificationWindow,
  normalizeNotificationPreferences,
  notificationDigestGroupKey,
  type NotificationCategory,
  type NotificationPreferences
} from "../notification-preferences.js";
import { enqueueNotificationDigest, type NotificationDigestPayload } from "../services/jobs.js";

export function createApiRuntimeStores(deps: {
  configuredApiKey: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
  auditLogger?: AuditLogger;
  createAppClient: () => AppPostgresClient;
  createSystemClient?: () => SystemKnowledgeSqlClient;
  probeEmbeddingProvider: () => Promise<OllamaEmbeddingProviderStatus>;
  queryEmbeddingProvider: (query: string) => Promise<number[]>;
}) {
  const {
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    auditLogger,
    createAppClient,
    createSystemClient,
    probeEmbeddingProvider,
    queryEmbeddingProvider
  } = deps;

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
  const pgTemporal =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1"
      ? new PgTemporalKnowledgeRepository(appPostgresClient as never)
      : undefined;
  const pgCrossService =
    appPostgresClient && process.env.NOEMA_PG_STORES === "1"
      ? new PostgresCrossServiceRegistry(appPostgresClient as never)
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
  const registeredProjects = new Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>();
  const integrationEventMemory = new Map<string, { eventHash: string; response?: Record<string, unknown> }>();
  const testExecutionMemory = new Map<string, { testItemId: string; accessPolicyId: string; commitSha: string; repository?: string; status: "passed" | "failed" | "skipped"; durationMs: number | null; executedAt: string; receivedBy: string }>();
  const githubMainHeadMemory = new Map<string, { repository: string; commitSha: string; accessPolicyId: string }>();

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

  async function enforceOpa(
    ctx: AuthContext,
    resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
  ) {
    const allowed = await evaluateOpaPolicy(ctx, resource);
    if (!allowed) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `OPA negou ação '${resource.action}' em '${resource.projectId}'.`, 403);
    }
  }

  function recordAudit(ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) {
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
    if (opRepo) {
      return opRepo.resolveEffectiveAuthContext(ctx, projectId);
    }
    return ctx;
  }

  async function close() {
    await appPostgresClient?.close();
    await operationalDatabaseClient?.client.end({ timeout: 5 });
    if (ownedSystemSqlClient) await ownedSystemSqlClient.end({ timeout: 5 });
  }

  return {
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
    memoryNotificationPreferences,
    integrationFallbackOwners,
    integrationReconnectHistory,
    departmentQuotas,
    accessMembers,
    temporaryGrants,
    customPolicyCatalog,
    shreddedSubjectKeys,
    registeredProjects,
    integrationEventMemory,
    testExecutionMemory,
    githubMainHeadMemory,
    notificationPreferenceKey,
    accessMemberKey,
    customPolicyKey,
    getNotificationPreferences,
    queueNotificationDigest,
    enforceOpa,
    recordAudit,
    authenticateProjectRequest,
    close
  };
}

