import { HandoffStore } from "@brain/agent-handoff";
import { BrainRunnerQueue } from "@brain/agent-runner";
import { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import {
  createPostgresAuditLogger,
  type AppPostgresClient,
  type AuditLogger,
  type RlsSessionContext
} from "@brain/audit-engine";
import { assertProjectAccess, authenticateRequest, buildAbilityForContext, resolveDefaultPermissionsForRoles, subject, usersStore, type AuthContext } from "@brain/auth";
import { ContextEngine } from "@brain/context-engine";
import { BrainError, type KnowledgeItem } from "@brain/core";
import { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import { createDatabaseClient, PgAuthRepository, PgMcpAuthRepository, PgOperationalRepository, PgSystemSettingsRepository } from "@brain/database";
import { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import { PostgresKnowledgeRepository, type SystemKnowledgeSqlClient } from "@brain/knowledge";
import { PostgresMemoryManager } from "@brain/memory";
import {
  HybridRetrievalEngine,
  PostgresRetrievalEngine,
  ValkeyRetrievalCache,
  type AsyncRetrievalEngine,
  type SearchQuery
} from "@brain/retrieval";
import { TemporalKnowledgeEngine, PgTemporalKnowledgeRepository } from "@brain/temporal-knowledge";
import type { OllamaEmbeddingProviderStatus } from "@brain/worker";

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
  if (!systemKnowledgeClient && process.env.BRAIN_PG_STORES === "1" && process.env.DATABASE_SYSTEM_URL) {
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

  const pgGraph = appPostgresClient && process.env.BRAIN_PG_STORES === "1" ? new PostgresGraphStore(appPostgresClient) : undefined;
  const valkeyUrl = process.env.VALKEY_URL ?? process.env.REDIS_URL;
  const pgRetrieval =
    appPostgresClient && process.env.BRAIN_PG_STORES === "1"
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
  const pgMemory = appPostgresClient && process.env.BRAIN_PG_STORES === "1"
    ? new PostgresMemoryManager(appPostgresClient as never)
    : undefined;
  const pgKnowledge =
    appPostgresClient && process.env.BRAIN_PG_STORES === "1" ? new PostgresKnowledgeRepository(appPostgresClient as never) : undefined;
  const pgApprovals =
    appPostgresClient && process.env.BRAIN_PG_STORES === "1" ? new PostgresApprovalQueue(appPostgresClient as never) : undefined;
  const opRepo =
    process.env.DATABASE_URL && process.env.BRAIN_PG_STORES === "1"
      ? (() => {
          operationalDatabaseClient = createDatabaseClient(process.env.DATABASE_URL);
          return new PgOperationalRepository(operationalDatabaseClient.db);
        })()
      : undefined;
  const authRepo = operationalDatabaseClient ? new PgAuthRepository(operationalDatabaseClient.db) : undefined;
  const mcpAuthRepo = operationalDatabaseClient ? new PgMcpAuthRepository(operationalDatabaseClient.db) : undefined;
  const systemSettingsRepo = operationalDatabaseClient ? new PgSystemSettingsRepository(operationalDatabaseClient.db) : undefined;
  const systemDb = process.env.DATABASE_SYSTEM_URL ? createDatabaseClient(process.env.DATABASE_SYSTEM_URL).db : undefined;
  const pgTemporal =
    appPostgresClient && process.env.BRAIN_PG_STORES === "1"
      ? new PgTemporalKnowledgeRepository(appPostgresClient as never)
      : undefined;
  const pgCrossService =
    appPostgresClient && process.env.BRAIN_PG_STORES === "1"
      ? new PostgresCrossServiceRegistry(appPostgresClient as never)
      : undefined;

  const upsertKnowledgeItem = async (ctx: AuthContext, item: KnowledgeItem) => {
    retrieval.upsertItem(item);
    if (pgKnowledge) {
      await pgKnowledge.upsertItem(ctx, item);
      pgRetrieval?.invalidateCache(ctx.tenantId, item.projectId);
    }
  };

  const departmentQuotas = new Map<string, { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; updatedAt: string }>();
  const accessMembers = new Map<string, { actorId: string; roles: string[]; allowedPolicies: string[]; updatedAt: string; syncedWithKeycloak: boolean }>();
  const temporaryGrants = new Map<string, { grantId: string; tenantId: string; projectId: string; actorId: string; roles: string[]; policyIds: string[]; expiresAt: string; grantedBy: string; createdAt: string }>();
  const customPolicyCatalog = new Map<string, { policyId: string; label: string; description: string; allowedRoles: string[]; updatedAt: string }>();
  const shreddedSubjectKeys = new Set<string>();
  const registeredProjects = new Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>();
  const integrationEventMemory = new Map<string, { eventHash: string; response?: Record<string, unknown> }>();
  const testExecutionMemory = new Map<string, { testItemId: string; accessPolicyId: string; commitSha: string; repository?: string; status: "passed" | "failed" | "skipped"; durationMs: number | null; executedAt: string; receivedBy: string }>();
  const githubMainHeadMemory = new Map<string, { repository: string; commitSha: string; accessPolicyId: string }>();

  const accessMemberKey = (ctx: AuthContext, projectId: string, actorId: string) => `${ctx.tenantId}:${projectId}:${actorId}`;
  const customPolicyKey = (ctx: AuthContext, projectId: string, policyId: string) => `${ctx.tenantId}:${projectId}:${policyId}`;

  async function enforceOpa(
    ctx: AuthContext,
    resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
  ) {
    const ability = buildAbilityForContext(ctx);
    const allowed = ability.can(resource.action, subject("Knowledge", resource));
    if (!allowed) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `CASL negou ação '${resource.action}' em '${resource.projectId}'.`, 403);
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
    const rawCtx = await authenticateRequest(headerValue, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const dbUser = authRepo ? await authRepo.findUserById(rawCtx.actorId) : null;
    const memUser = !dbUser && rawCtx.actorId !== "local-dev" ? usersStore.getUserById(rawCtx.actorId) : null;
    const freshUser = dbUser ?? memUser;
    const baseCtx: AuthContext = freshUser
      ? {
          ...rawCtx,
          roles: freshUser.roles,
          allowedProjects: freshUser.allowedProjects,
          allowedPolicies: freshUser.allowedPolicies
        }
      : rawCtx;
    const ctx = opRepo
      ? await opRepo.resolveDynamicMcpScope(baseCtx, freshUser ? [] : allowedProjects, allowedPolicies, systemDb)
      : baseCtx;
    if (projectId === "__global__") {
      return {
        ...ctx,
        permissions: ctx.permissions && ctx.permissions.length > 0 ? ctx.permissions : resolveDefaultPermissionsForRoles(ctx.roles)
      };
    }
    if (!ctx.allowedProjects.includes(projectId) && opRepo) {
      const effectivePerms = ctx.permissions && ctx.permissions.length > 0 ? ctx.permissions : resolveDefaultPermissionsForRoles(ctx.roles);
      if (effectivePerms.includes("projects:shared:read")) {
        const sharedList = await opRepo.listSharedProjects(ctx.tenantId, systemDb);
        if (sharedList.some((p) => p.projectId === projectId)) {
          ctx.allowedProjects = [...new Set([...ctx.allowedProjects, projectId])];
        }
      }
    }
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
    operationalDb: operationalDatabaseClient?.db,
    authRepo,
    mcpAuthRepo,
    systemSettingsRepo,
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
    close
  };
}

