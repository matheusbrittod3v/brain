import type { FastifyInstance } from "fastify";
import type { HandoffStore } from "@brain/agent-handoff";
import type { BrainRunnerQueue } from "@brain/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import type { AuditLogger } from "@brain/audit-engine";
import {
  authenticateRequest,
  exportAbilityRules,
  resolveDefaultPermissionsForRoles,
  usersStore,
  type AuthContext
} from "@brain/auth";
import type { ContextEngine } from "@brain/context-engine";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import { createDatabaseClient, type PgAuthRepository, type PgMcpAuthRepository, type PgOperationalRepository, type PgSystemSettingsRepository } from "@brain/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import { scanForSecrets } from "@brain/ingestion";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import type { PostgresMemoryManager } from "@brain/memory";
import type { AsyncRetrievalEngine, PostgresRetrievalEngine } from "@brain/retrieval";
import { assertSecretScanClean } from "../services/ai-worker.js";
import { registerMcpGatewayRoutes } from "./mcp-gateway.js";
import { registerSystemSettingsRoutes } from "./system-settings.js";
import { registerEvolutionPrioritiesRoutes } from "./evolution-priorities.js";

export type DeveloperProfileData = {
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

export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    deploymentMode: "local" | "cloud";
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    opRepo?: PgOperationalRepository;
    authRepo?: PgAuthRepository;
    mcpAuthRepo?: PgMcpAuthRepository;
    systemSettingsRepo?: PgSystemSettingsRepository;
    pgGraph?: PostgresGraphStore;
    graph: KnowledgeGraphStore;
    queryAwareRetrieval: AsyncRetrievalEngine;
    pgRetrieval?: PostgresRetrievalEngine;
    contextEngine: ContextEngine<AsyncRetrievalEngine>;
    handoffs: HandoffStore;
    runner: BrainRunnerQueue;
    pgMemory?: PostgresMemoryManager;
    pgKnowledge?: PostgresKnowledgeRepository;
    pgCrossService?: PostgresCrossServiceRegistry;
    crossService: CrossServiceContractRegistry;
    pgApprovals?: PostgresApprovalQueue;
    approvals?: ApprovalQueue;
    registeredProjects: Map<string, unknown>;
  }
) {
  const {
    deploymentMode,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    recordAudit,
    opRepo,
    authRepo,
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
    registeredProjects
  } = deps;

  const systemDb = process.env.DATABASE_SYSTEM_URL ? createDatabaseClient(process.env.DATABASE_SYSTEM_URL).db : undefined;

  app.get("/v1/health", async () => ({ service: "brain-api", status: "ok", version: "0.1.0", deploymentMode }));

  app.get<{ Querystring: { projectId?: string } }>("/v1/auth/me", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const memUser = usersStore.getUserById(ctx.actorId);
    const dbUser = authRepo ? await authRepo.findUserById(ctx.actorId) : null;
    const user = dbUser ?? memUser;
    const baseCtx: AuthContext = dbUser
      ? {
          ...ctx,
          roles: dbUser.roles,
          allowedProjects: dbUser.allowedProjects,
          allowedPolicies: dbUser.allowedPolicies
        }
      : ctx;
    const scopedCtx = opRepo
      ? await opRepo.resolveDynamicMcpScope(baseCtx, user ? [] : allowedProjects, allowedPolicies, systemDb)
      : baseCtx;
    const effectiveCtx =
      req.query.projectId && opRepo && scopedCtx.allowedProjects.includes(req.query.projectId)
        ? await opRepo.resolveEffectiveAuthContext(scopedCtx, req.query.projectId)
        : scopedCtx;
    const visibilityScope = effectiveCtx.roles.some((r) => ["admin", "appsec", "cto"].includes(r))
      ? "org"
      : effectiveCtx.roles.some((r) => ["tech-lead", "po", "reviewer"].includes(r))
        ? "project"
        : "self";
    const resolvedPermissions =
      effectiveCtx.permissions && effectiveCtx.permissions.length > 0
        ? effectiveCtx.permissions
        : resolveDefaultPermissionsForRoles(effectiveCtx.roles);
    return {
      tenantId: effectiveCtx.tenantId,
      actorId: effectiveCtx.actorId,
      actorType: effectiveCtx.actorType,
      email: user?.email,
      name: user?.name,
      roles: effectiveCtx.roles,
      allowedProjects: effectiveCtx.allowedProjects,
      allowedPolicies: effectiveCtx.allowedPolicies,
      permissions: resolvedPermissions,
      abilities: exportAbilityRules(effectiveCtx),
      visibilityScope
    };
  });

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

  // System Settings persisted in PostgreSQL + Universal Agent Gateway + MCP Streamable HTTP
  registerSystemSettingsRoutes(app, deps);
  registerEvolutionPrioritiesRoutes(app, deps);
  registerMcpGatewayRoutes(app, deps);

  return { getDeveloperProfile };
}
