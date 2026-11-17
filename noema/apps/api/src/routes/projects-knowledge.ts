import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { BrainRunnerQueue } from "@noema/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AppPostgresClient, AuditLogger } from "@noema/audit-engine";
import { assertPolicyAccess, authenticateRequest, type AuthContext } from "@noema/auth";
import { BrainError, paginateCursor, type KnowledgeItem } from "@noema/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@noema/cross-service";
import type { PgOperationalRepository } from "@noema/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import { analyzeDistributedImpact } from "@noema/impact-analysis";
import { parseKnowledgeFile, type PostgresKnowledgeRepository } from "@noema/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { findChangedWorkspaceSources } from "@noema/workspace-detection";
import { rerankWithAiWorker } from "../services/ai-worker.js";
import { configuredWorkspaceRoot, enqueueApprovalReminders } from "../services/jobs.js";

export function registerProjectsKnowledgeRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; domains?: number[]; atDate?: string; limit: number }) => Promise<Array<{ item: KnowledgeItem; score: number }>> };
    projectVerifiedTests: (ctx: AuthContext, projectId: string, items: KnowledgeItem[]) => Promise<any>;
    projectHealth: (items: KnowledgeItem[], verifiedTests: Map<string, string[]>, linkedTestsByRule?: Map<string, string[]>) => any;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    registeredProjects: Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>;
    opRepo?: PgOperationalRepository;
    appPostgresClient?: AppPostgresClient;
    pgRetrieval?: PostgresRetrievalEngine;
    retrieval: HybridRetrievalEngine;
    pgKnowledge?: PostgresKnowledgeRepository;
    pgGraph?: PostgresGraphStore;
    graph: KnowledgeGraphStore;
    pgApprovals?: PostgresApprovalQueue;
    approvals: ApprovalQueue;
    runner: BrainRunnerQueue;
    pgCrossService?: PostgresCrossServiceRegistry;
    crossService: CrossServiceContractRegistry;
  }
) {
  const {
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
  } = deps;

  app.get("/v1/projects", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const projects = opRepo
      ? await opRepo.listProjects(ctx)
      : [...registeredProjects.values()].filter(
          (p) => p.tenantId === ctx.tenantId && (ctx.allowedProjects.includes("*") || ctx.allowedProjects.includes(p.projectId))
        );
    return { projects };
  });

  app.post<{ Body: { projectId: string; name?: string; description?: string; knowledgeRoot?: string } }>(
    "/v1/projects",
    async (req) => {
      const projectId = req.body.projectId?.trim();
      if (!projectId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "projectId deve usar slug minúsculo alfanumérico/hífens (ex.: 'billing-api').", 400);
      }
      const ctx = await authenticateProjectRequest(req.headers.authorization, projectId);
      await enforceOpa(ctx, { projectId, accessPolicyId: "internal-project", action: "write" });
      const name = req.body.name?.trim() || projectId;
      const description = req.body.description?.trim() || undefined;
      const knowledgeRoot = req.body.knowledgeRoot?.trim() || ".brain/";

      const result = opRepo
        ? await opRepo.registerProject(ctx, { projectId, name, description, knowledgeRoot })
        : (() => {
            const key = `${ctx.tenantId}:${projectId}`;
            const existing = registeredProjects.get(key);
            if (existing) {
              const updated = { ...existing, name, description: description ?? existing.description, knowledgeRoot };
              registeredProjects.set(key, updated);
              return { created: false, project: updated };
            }
            const createdProject = { projectId, tenantId: ctx.tenantId, name, description, knowledgeRoot, createdAt: new Date().toISOString() };
            registeredProjects.set(key, createdProject);
            return { created: true, project: createdProject };
          })();

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: result.created ? "create" : "update",
        targetType: "project",
        targetId: projectId,
        metadata: { name: result.project.name, knowledgeRoot: result.project.knowledgeRoot }
      });
      return result;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/overview", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const items = hits.map((h) => h.item);
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const health = projectHealth(items, evidence.verifiedTests);
    const linkedMap = evidence.linkedTestsByRule as Map<string, string[]> | undefined;
    const graphVerified = new Map<string, string[]>(evidence.verifiedTests);
    if (linkedMap) {
      for (const [ruleId, testIds] of linkedMap.entries()) {
        if (testIds.length > 0 && !graphVerified.has(ruleId)) {
          graphVerified.set(ruleId, testIds);
        }
      }
    }
    const graphHealth = projectHealth(items, graphVerified);
    const alerts: string[] = [];
    if (health.untestedRuleIds.length > 0) alerts.push(`${health.untestedRuleIds.length} regra(s) sem cobertura de testes: ${health.untestedRuleIds.join(", ")}`);
    if (health.staleItemIds.length > 0) alerts.push(`${health.staleItemIds.length} item(ns) desatualizado(s) (>90d): ${health.staleItemIds.join(", ")}`);
    if (health.gitVsConnectorConflicts.length > 0) alerts.push(`${health.gitVsConnectorConflicts.length} conflito(s) Git vs Connector detectado(s).`);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byPolicy: Record<string, number> = {};
    for (const item of items) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      byPolicy[item.accessPolicyId] = (byPolicy[item.accessPolicyId] ?? 0) + 1;
    }
    const activeRules = items.filter((i) => i.type === "business_rule" && i.status !== "deprecated");
    const graphLinkedRulesCount = activeRules.filter((r) => (linkedMap?.get(r.id)?.length ?? 0) > 0).length;
    const ciVerifiedRulesCount = activeRules.filter((r) => (evidence.verifiedTests.get(r.id)?.length ?? 0) > 0).length;
    return {
      projectId: req.params.projectId,
      totalItems: items.length,
      approvedCount: items.filter((i) => i.status === "approved").length,
      draftCount: items.filter((i) => i.status === "draft").length,
      health,
      graphHealth,
      alerts,
      summary: {
        byType,
        byStatus,
        byPolicy,
        rulesCount: activeRules.length,
        testsCount: items.filter((i) => i.type === "test").length,
        graphLinkedRulesCount,
        ciVerifiedRulesCount
      }
    };
  });

  app.post<{ Params: { projectId: string }; Body: { query: string; domains?: number[]; limit?: number; cursor?: string; atDate?: string } }>(
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
      const item = pgRetrieval ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.itemId) : retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${req.params.itemId}' não encontrado.`, 404);
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

  app.patch<{ Params: { projectId: string; itemId: string }; Body: { status: "draft" | "approved" | "deprecated" | "superseded" } }>(
    "/v1/projects/:projectId/knowledge/:itemId/status",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), itemId: Type.String() }),
        body: Type.Object({ status: Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("deprecated"), Type.Literal("superseded")]) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgRetrieval ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.itemId) : retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${req.params.itemId}' não encontrado.`, 404);
      if (req.body.status === "approved" && ctx.actorType === "agent" && !ctx.inheritUserPermissions && !ctx.allowedActions?.includes("approve")) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Agentes não podem aprovar conhecimento oficial sem vínculo/delegação de usuário.", 403);
      }
      await enforceOpa(ctx, {
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        action: req.body.status === "approved" ? "approve" : "update",
        domainId: item.domainId
      });
      const updated = {
        ...item,
        status: req.body.status,
        ...(req.body.status === "approved" ? { isInferred: false } : {}),
        updatedAt: new Date().toISOString()
      };
      await upsertKnowledgeItem(ctx, updated);
      if (pgApprovals && (req.body.status === "approved" || req.body.status === "deprecated")) {
        try {
          await pgApprovals.decide(ctx, req.params.projectId, req.params.itemId, req.body.status === "approved");
        } catch (err) {
          if (!(err instanceof BrainError && err.code === "BRAIN_ERR_NOT_FOUND")) throw err;
        }
      }
      pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: req.body.status === "approved" ? "approve" : "update",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { previousStatus: item.status, nextStatus: req.body.status }
      });
      return { item: updated };
    }
  );

  app.get<{ Params: { projectId: string; itemId: string } }>("/v1/projects/:projectId/knowledge/:itemId/versions", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (pgKnowledge) return { itemId: req.params.itemId, versions: await pgKnowledge.listVersions(ctx, req.params.projectId, req.params.itemId) };
    const item = retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
    return { itemId: req.params.itemId, versions: item ? [item] : [] };
  });

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
        const item = pgRetrieval ? await pgRetrieval.getItem(ctx, req.params.projectId, itemId) : retrieval.getItem(ctx, req.params.projectId, itemId);
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
      metadata: { rating: req.body.rating, itemIds, comment: req.body.comment }
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

  app.get<{ Params: { projectId: string; taskId: string } }>("/v1/projects/:projectId/runner/tasks/:taskId", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (process.env.NOEMA_PG_STORES === "1") {
      const opGetTask = (opRepo as { getRunnerTask?: (c: typeof ctx, projectId: string, taskId: string) => Promise<unknown> } | undefined)?.getRunnerTask;
      if (opGetTask) {
        const found = await opGetTask.call(opRepo, ctx, req.params.projectId, req.params.taskId);
        if (found) return found;
      } else if (appPostgresClient) {
        const pgTask = await appPostgresClient.withRlsTransaction(
          { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
          async (client) => {
            const rows = (await client`
              SELECT task_id, tenant_id, project_id, instruction, priority, draft_only, max_steps, timeout_seconds, status, result_summary, result_metadata, created_at
              FROM runner_tasks
              WHERE tenant_id = ${ctx.tenantId} AND project_id = ${req.params.projectId} AND task_id = ${req.params.taskId}
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
    if (!task) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Task '${req.params.taskId}' não encontrada.`, 404);
    return task;
  });

  app.post<{ Params: { projectId: string }; Body: { targetIds: string[] } }>("/v1/projects/:projectId/change/impact", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const targetIds = [...new Set(req.body.targetIds ?? [])];
    if (targetIds.length === 0) throw new BrainError("BRAIN_ERR_CONFLICT", "Informe ao menos um targetId para analisar impacto.", 400);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "business_rule", domains: [2], limit: 200 });
    const report = await analyzeDistributedImpact(ctx, pgGraph ?? graph, req.params.projectId, targetIds, {
      rules: hits.map((hit) => hit.item),
      crossServiceRegistry: pgCrossService ?? crossService
    });
    return { ...report };
  });

  app.post<{ Params: { projectId: string }; Body: { title: string; content: string; targetType?: string; relatedIds?: string[] } }>(
    "/v1/projects/:projectId/change/propose",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          title: Type.String({ minLength: 1 }),
          content: Type.String({ minLength: 1 }),
          targetType: Type.Optional(Type.String()),
          relatedIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
        })
      }
    },
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
        const target = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, targetId) : retrieval.getItem(ctx, req.params.projectId, targetId);
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

  const relationTypeSchema = Type.Union([
    Type.Literal("IMPLEMENTS"),
    Type.Literal("GOVERNED_BY"),
    Type.Literal("DEPENDS_ON"),
    Type.Literal("DECIDED_BY"),
    Type.Literal("VERIFIED_BY"),
    Type.Literal("BLOCKED_BY"),
    Type.Literal("SUPERSEDES"),
    Type.Literal("IMPACTS"),
    Type.Literal("CONSUMES_API"),
    Type.Literal("PUBLISHES_EVENT"),
    Type.Literal("SUBSCRIBES_TO"),
    Type.Literal("CO_ACCESSED_WITH")
  ]);

  app.post<{
    Params: { projectId: string };
    Body: {
      fromItemId?: string;
      toItemId?: string;
      relationType?: "IMPLEMENTS" | "GOVERNED_BY" | "DEPENDS_ON" | "DECIDED_BY" | "VERIFIED_BY" | "BLOCKED_BY" | "SUPERSEDES" | "IMPACTS" | "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO" | "CO_ACCESSED_WITH";
      confidence?: number;
      evidenceUri?: string;
      relations?: Array<{
        fromItemId: string;
        toItemId: string;
        relationType: "IMPLEMENTS" | "GOVERNED_BY" | "DEPENDS_ON" | "DECIDED_BY" | "VERIFIED_BY" | "BLOCKED_BY" | "SUPERSEDES" | "IMPACTS" | "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO" | "CO_ACCESSED_WITH";
        confidence?: number;
        evidenceUri?: string;
      }>;
    };
  }>("/v1/projects/:projectId/graph/relations", {
    schema: {
      params: Type.Object({ projectId: Type.String() }),
      body: Type.Object({
        fromItemId: Type.Optional(Type.String({ minLength: 1 })),
        toItemId: Type.Optional(Type.String({ minLength: 1 })),
        relationType: Type.Optional(relationTypeSchema),
        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        evidenceUri: Type.Optional(Type.String()),
        relations: Type.Optional(Type.Array(Type.Object({
          fromItemId: Type.String({ minLength: 1 }),
          toItemId: Type.String({ minLength: 1 }),
          relationType: relationTypeSchema,
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          evidenceUri: Type.Optional(Type.String())
        })))
      })
    }
  }, async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const inputs = req.body.relations && req.body.relations.length > 0
      ? req.body.relations
      : req.body.fromItemId && req.body.toItemId && req.body.relationType
        ? [{
            fromItemId: req.body.fromItemId,
            toItemId: req.body.toItemId,
            relationType: req.body.relationType,
            confidence: req.body.confidence,
            evidenceUri: req.body.evidenceUri
          }]
        : [];
    if (inputs.length === 0) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Informe fromItemId, toItemId e relationType (ou relations[]).", 400);
    }
    const created = [];
    for (const rel of inputs) {
      const fromItem = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, rel.fromItemId) : retrieval.getItem(ctx, req.params.projectId, rel.fromItemId);
      const toItem = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, rel.toItemId) : retrieval.getItem(ctx, req.params.projectId, rel.toItemId);
      const fromPolicyId = fromItem?.accessPolicyId ?? "internal-project";
      const toPolicyId = toItem?.accessPolicyId ?? "internal-project";
      assertPolicyAccess(ctx, fromPolicyId);
      assertPolicyAccess(ctx, toPolicyId);
      const edge = {
        tenantId: ctx.tenantId,
        fromProjectId: req.params.projectId,
        toProjectId: req.params.projectId,
        fromItemId: rel.fromItemId,
        toItemId: rel.toItemId,
        fromPolicyId,
        toPolicyId,
        relationType: rel.relationType,
        isInferred: false as const,
        confidence: rel.confidence ?? 1.0,
        ...(rel.evidenceUri ? { evidenceUri: rel.evidenceUri } : {})
      };
      graph.addEdge(edge);
      if (pgGraph) await pgGraph.addEdge(ctx, edge);
      created.push(edge);
    }
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "graph_relations",
      targetId: `${created[0]!.fromItemId}->${created[0]!.toItemId}`,
      metadata: { count: created.length }
    });
    return { created: created.length, relations: created };
  });
}

