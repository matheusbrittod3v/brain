import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@noema/audit-engine";
import { assertProjectAccess, authenticateRequest, type AuthContext } from "@noema/auth";
import { BrainError } from "@noema/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import type { PgOperationalRepository } from "@noema/database";
import { enqueueRemoteGitIngestJob } from "../services/jobs.js";

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
    githubMainHeadMemory
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
    if (systemSql && process.env.NOEMA_PG_BOSS === "1") {
      githubJobs = await systemSql<Array<Record<string, unknown>>>`
        SELECT id, state, retry_count, created_on, completed_on, data->>'owner' AS owner,
          data->>'repo' AS repo, data->>'ref' AS ref, output
        FROM pgboss.job WHERE name = 'noema.ingest-git'
          AND data->>'tenantId' = ${ctx.tenantId} AND data->>'projectId' = ${req.params.projectId}
          AND data ? 'owner' AND data ? 'repo'
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
      }
    };
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/cross-service/contracts", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const projectIds = req.query.projectId ? [req.query.projectId] : undefined;
    if (req.query.projectId) assertProjectAccess(ctx, req.query.projectId);
    const contracts = pgCrossService ? await pgCrossService.getContracts(ctx, projectIds) : crossService.getContracts(ctx, projectIds);
    return { contracts };
  });
}

