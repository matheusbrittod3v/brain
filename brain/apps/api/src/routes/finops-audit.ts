import type { FastifyInstance } from "fastify";
import { getRecentUsageLogs, getUsageSummary } from "@brain/agent-runner";
import type { AppPostgresClient, AuditLogger } from "@brain/audit-engine";
import { assertProjectAccess, authenticateRequest, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgOperationalRepository } from "@brain/database";
import { normalizeAuditLogRow } from "../services/jobs.js";
import { estimateInfraAndEnergyUsd, evaluateFinopsQuotas } from "../services/finops-quota.js";

export function registerFinopsAuditRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: { content: string } }>> };
    projectModelUsage: (ctx: AuthContext, projectId: string) => Promise<{
      windowDays: number;
      modelUsageAvailable: boolean;
      calls: number;
      byModel: Array<{ provider: string; model: string; costBasis: string; calls: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; providerCostUsd: number | null }>;
      providerCostUsd: number | null;
      infrastructureCostAvailable: boolean;
    }>;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    appPostgresClient?: AppPostgresClient;
    auditLogger?: AuditLogger;
    opRepo?: PgOperationalRepository;
    pgTemporal?: unknown;
    departmentQuotas: Map<string, { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; downgradeModel?: string; updatedAt: string }>;
  }
) {
  const {
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
  } = deps;

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
        { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
        async (client) => {
          if (projectId) {
            return (await client`
              SELECT id, tenant_id, project_id, actor_id, actor_type, access_policy_id, action, target_type, target_id, created_at
              FROM audit_logs
              WHERE project_id = ${projectId}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `) as Array<Record<string, unknown>>;
          }
          return (await client`
            SELECT id, tenant_id, project_id, actor_id, actor_type, access_policy_id, action, target_type, target_id, created_at
            FROM audit_logs
            ORDER BY created_at DESC
            LIMIT ${limit}
          `) as Array<Record<string, unknown>>;
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

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/finops", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const items = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const modelUsage = await projectModelUsage(ctx, req.params.projectId);
    const estimatedLocalTokens = items.reduce((acc, h) => acc + Math.ceil(h.item.content.length / 4), 0);

    const measuredTokens = modelUsage.byModel.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0);
    const totalTokens = measuredTokens > 0 ? measuredTokens : estimatedLocalTokens;
    const { estimatedInfraUsd, estimatedEnergyKwh, estimatedEnergyUsd } = estimateInfraAndEnergyUsd(totalTokens, modelUsage.calls);

    const quotaPrefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const rawQuotas = opRepo
      ? await opRepo.listDepartmentFinopsQuotas(ctx, req.params.projectId)
      : [...departmentQuotas.entries()].filter(([key]) => key.startsWith(quotaPrefix)).map(([, q]) => q);
    const quotas = evaluateFinopsQuotas(rawQuotas, modelUsage, estimatedLocalTokens);

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
      : [...departmentQuotas.entries()].filter(([key]) => key.startsWith(prefix)).map(([, q]) => q);
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
          const localEntry = { department, monthlyTokenLimit, monthlyUsdLimit, downgradeModel: req.body.downgradeModel?.trim() || undefined, updatedAt: new Date().toISOString() };
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

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>(
    "/v1/projects/:projectId/finops/usage-stats",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? "50", 10) || 50));
      return {
        summary: getUsageSummary(),
        logs: getRecentUsageLogs(limit)
      };
    }
  );
}

