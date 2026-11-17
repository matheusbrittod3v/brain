import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HandoffStore } from "@noema/agent-handoff";
import type { BrainRunnerQueue } from "@noema/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AuditLogger } from "@noema/audit-engine";
import { authenticateRequest, type AuthContext } from "@noema/auth";
import type { ContextEngine } from "@noema/context-engine";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import type { PgOperationalRepository } from "@noema/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import { scanForSecrets } from "@noema/ingestion";
import type { PostgresKnowledgeRepository } from "@noema/knowledge";
import { createNoemaMcpServer, createRunnerSchedule } from "@noema/mcp-server";
import type { PostgresMemoryManager } from "@noema/memory";
import type { AsyncRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { assertSecretScanClean } from "../services/ai-worker.js";

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

  app.get("/v1/health", async () => ({ service: "noema-api", status: "ok", version: "0.1.0", deploymentMode }));

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

  // Universal Agent Gateway + MCP Streamable HTTP (Item 7 & 37)
  app.get("/gateway", async () => ({
    gateway: "noema-universal-agent-gateway",
    deploymentMode,
    transports: ["streamable-http", "stdio", "rest"],
    mcpEndpoint: "/mcp",
    toolsCount: 35,
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
      registeredProjects,
      audit: {
        record: (event: Parameters<AuditLogger["record"]>[0]) => recordAudit(ctx, event)
      }
    };
    const mcpServer = createNoemaMcpServer(mcpRuntime as never, ctx, "internal-project", "service");
    await mcpServer.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  return { getDeveloperProfile };
}
