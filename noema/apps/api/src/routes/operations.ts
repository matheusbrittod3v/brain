import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type { ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AppPostgresClient, AuditLogger } from "@noema/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@noema/auth";
import { BrainError, type KnowledgeItem } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import { buildBusinessRuleTestCoverageMatrix } from "@noema/enterprise-views";
import { scanForSecrets } from "@noema/ingestion";
import type { SystemKnowledgeSqlClient } from "@noema/knowledge";
import { planAutonomousTasks } from "@noema/task-engine";
import { orchestrateLivingDocDrafts } from "@noema/workflow-orchestrator";
import { assertSecretScanClean } from "../services/ai-worker.js";

export function registerOperationsRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: KnowledgeItem; score: number }>> };
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    projectVerifiedTests: (ctx: AuthContext, projectId: string, items: KnowledgeItem[]) => Promise<any>;
    projectHealth: (items: KnowledgeItem[], verifiedTests: any) => any;
    projectModelUsage: (ctx: AuthContext, projectId: string) => Promise<any>;
    computeLatencyTelemetry: () => unknown;
    appPostgresClient?: AppPostgresClient;
    ownedSystemSqlClient?: SystemKnowledgeSqlClient & (<T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>);
    opRepo?: PgOperationalRepository;
    pgApprovals?: PostgresApprovalQueue;
    approvals: ApprovalQueue;
  }
) {
  const {
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
  } = deps;

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
        for (const p of ctx.allowedProjects) if (p !== "*") targetProjects.add(p);
        if (appPostgresClient && process.env.DATABASE_URL) {
          const rows = await appPostgresClient.withRlsTransaction(
            { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
            async (client) => (await client`SELECT id FROM projects WHERE tenant_id = ${ctx.tenantId} LIMIT 50`) as Array<{ id: string }>
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
    if (!serviceSlug) throw new BrainError("BRAIN_ERR_CONFLICT", "Nome do serviço inválido para registro.", 400);
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
      contentHash: createHash("sha256").update(content).digest("hex"),
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
    const health = projectHealth(items, evidence.verifiedTests);
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
        queue: String(row.name),
        state: String(row.state),
        count: Number(row.count),
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
      if (!job) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Job '${req.params.jobId}' não encontrado neste projeto.`, 404);
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
        const reqSubmitted = pgApprovals ? await pgApprovals.submit(ctx, proposalItem) : approvals.submit(ctx, proposalItem);
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
}
