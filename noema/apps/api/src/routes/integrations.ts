import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@noema/audit-engine";
import { assertProjectAccess, authenticateRequest, type AuthContext } from "@noema/auth";
import type { SaasProvider } from "@noema/connector-saas";
import { BrainError } from "@noema/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import type { PgOperationalRepository } from "@noema/database";
import { enqueueRemoteGitIngestJob, enqueueSaasIngestJob } from "../services/jobs.js";

export function registerIntegrationsRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    ownedSystemSqlClient?: (<T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>);
    opRepo?: PgOperationalRepository;
    pgCrossService?: PostgresCrossServiceRegistry;
    crossService: CrossServiceContractRegistry;
    githubMainHeadMemory: Map<string, { repository: string; commitSha: string; accessPolicyId: string }>;
    integrationFallbackOwners: Map<string, { fallbackOwner: string; updatedAt: string; updatedBy: string }>;
    integrationReconnectHistory: Map<string, { lastReconnectAt: string; status: string; actorId: string }>;
  }
) {
  const {
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
    githubMainHeadMemory,
    integrationFallbackOwners,
    integrationReconnectHistory
  } = deps;

  app.post<{ Params: { projectId: string }; Body: { owner: string; repo: string; ref: string } }>(
    "/v1/projects/:projectId/github/ingest",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          owner: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9-]+$" }),
          repo: Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" }),
          ref: Type.String({ minLength: 1, maxLength: 255 })
        })
      }
    },
    async (req) => {
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
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "github_ingestion_job",
        targetId: jobId,
        metadata: { owner: req.body.owner, repo: req.body.repo, ref: req.body.ref }
      });
      return { accepted: true, provider: "github", owner: req.body.owner, repo: req.body.repo, ref: req.body.ref, jobId };
    }
  );

  app.get<{ Params: { projectId: string }; Querystring: { limit?: number } }>(
    "/v1/projects/:projectId/github/jobs",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) })
      }
    },
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
      try {
        repoMap = JSON.parse(rawRepoMap);
      } catch {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "NOEMA_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503);
      }
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
      : [...githubMainHeadMemory.entries()].filter(([key]) => key.startsWith(`${ctx.tenantId}:${req.params.projectId}:`)).map(([, head]) => head);
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
      : [...integrationFallbackOwners.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ provider: key.slice(prefix.length), ...value }));
    const reconnectHistory = opRepo
      ? await opRepo.listIntegrationReconnectHistory(ctx, req.params.projectId)
      : [...integrationReconnectHistory.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ provider: key.slice(prefix.length), ...value }));
    return {
      projectId: req.params.projectId,
      github: {
        state: systemSql && process.env.NOEMA_PG_BOSS === "1" ? "available" : "needs_configuration",
        privateRepoAuthConfigured: Boolean(process.env.GITHUB_TOKEN || (process.env.GITHUB_APP_ID && process.env.GITHUB_INSTALLATION_ID && process.env.GITHUB_APP_PRIVATE_KEY)),
        webhookConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET && githubMappings.length > 0),
        repositories: githubMappings,
        mainHeads: githubMainHeads.map((head) => ({ repository: head.repository, branch: "main", commitSha: head.commitSha })),
        recentJobs: githubJobs.map((row) => ({
          jobId: String(row.id), owner: String(row.owner), repo: String(row.repo), ref: String(row.ref), state: String(row.state),
          retries: Number(row.retry_count ?? 0), createdAt: String(row.created_on), completedAt: row.completed_on ? String(row.completed_on) : null, result: row.output ?? null
        }))
      },
      saas: {
        state: systemSql && process.env.NANGO_URL && process.env.NANGO_SECRET_KEY && process.env.NOEMA_PG_BOSS === "1" ? "available" : "needs_configuration",
        recentJobs: saasJobs.map((row) => ({
          jobId: String(row.id), provider: String(row.provider), connectionId: String(row.connection_id), state: String(row.state),
          retries: Number(row.retry_count ?? 0), createdAt: String(row.created_on), completedAt: row.completed_on ? String(row.completed_on) : null, result: row.output ?? null
        }))
      },
      notificationChannels,
      fallbackOwners,
      reconnectHistory,
      slackInteractiveApprovalConfigured: Boolean(process.env.NOEMA_WEBHOOK_SECRET_SLACK && slackActorMappingPresent)
    };
  });

  app.post<{ Params: { projectId: string; provider: string }; Body: { connectionId: string; model?: string } }>(
    "/v1/projects/:projectId/integrations/:provider/sync",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), provider: Type.String() }),
        body: Type.Object({ connectionId: Type.String({ minLength: 1, maxLength: 200 }), model: Type.Optional(Type.String({ maxLength: 100 })) })
      }
    },
    async (req) => {
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
      await recordAudit(ctx, {
        tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
        actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "saas_ingestion_job",
        targetId: jobId, metadata: { provider: req.params.provider, connectionId: req.body.connectionId, model: req.body.model }
      });
      return { accepted: true, provider: req.params.provider, connectionId: req.body.connectionId, jobId };
    }
  );

  app.get<{ Querystring: { projectId?: string } }>("/v1/cross-service/contracts", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const projectIds = req.query.projectId ? [req.query.projectId] : undefined;
    if (req.query.projectId) assertProjectAccess(ctx, req.query.projectId);
    const contracts = pgCrossService ? await pgCrossService.getContracts(ctx, projectIds) : crossService.getContracts(ctx, projectIds);
    return { contracts };
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
        tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
        actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "integration_reconnect",
        targetId: req.params.provider, metadata: { status }
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
      if (!fallbackOwner) throw new BrainError("BRAIN_ERR_CONFLICT", "fallbackOwner não pode estar vazio.", 400);
      const key = `${ctx.tenantId}:${req.params.projectId}:${req.params.provider}`;
      const entry = opRepo
        ? await opRepo.upsertIntegrationFallbackOwner(ctx, req.params.projectId, req.params.provider, fallbackOwner)
        : (() => {
            const localEntry = { fallbackOwner, updatedAt: new Date().toISOString(), updatedBy: ctx.actorId };
            integrationFallbackOwners.set(key, localEntry);
            return localEntry;
          })();
      await recordAudit(ctx, {
        tenantId: ctx.tenantId, projectId: req.params.projectId, accessPolicyId: "internal-project",
        actorId: ctx.actorId, actorType: ctx.actorType, action: "update", targetType: "integration_fallback_owner",
        targetId: req.params.provider, metadata: { fallbackOwner }
      });
      return { provider: req.params.provider, ...entry };
    }
  );
}

