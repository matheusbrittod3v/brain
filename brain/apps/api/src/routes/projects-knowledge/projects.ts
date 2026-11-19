import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "@brain/auth";
import { BrainError, paginateCursor, type KnowledgeItem } from "@brain/core";
import { scanForSecrets } from "@brain/ingestion";
import { assertSecretScanClean, redactPiiWithAiWorker, rerankWithAiWorker } from "../../services/ai-worker.js";
import { configuredWorkspaceRoot } from "../../services/jobs.js";
import type { ProjectsKnowledgeDeps } from "./types.js";

export function registerProjectCoreRoutes(app: FastifyInstance, deps: ProjectsKnowledgeDeps) {
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
    pgRetrieval,
    retrieval
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

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/skills", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const projectHits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 200 });
    const projectSkills = projectHits
      .map((h) => h.item)
      .filter((item) => item.type === "skill" && item.status !== "deprecated")
      .map((item) => ({ ...item, scope: "project" as const }));

    let orgSkills: Array<KnowledgeItem & { scope: "org" }> = [];
    if (req.params.projectId !== "__org__" && (ctx.allowedProjects.includes("__org__") || ctx.roles.includes("admin"))) {
      try {
        const orgCtx = { ...ctx, allowedProjects: [...new Set([...ctx.allowedProjects, "__org__"])] };
        const orgHits = await queryAwareRetrieval.search(orgCtx, { projectId: "__org__", query: "", limit: 200 });
        orgSkills = orgHits
          .map((h) => h.item)
          .filter((item) => item.type === "skill" && item.status !== "deprecated")
          .map((item) => ({ ...item, scope: "org" as const }));
      } catch {
        // __org__ optional
      }
    }
    return { projectId: req.params.projectId, skills: [...projectSkills, ...orgSkills] };
  });

  app.post<{ Params: { projectId: string }; Body: { workspacePath?: string } }>(
    "/v1/projects/:projectId/brain/sync",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write", domainId: 2 });

      const projectMeta = registeredProjects.get(`${ctx.tenantId}:${req.params.projectId}`);
      const rootDir = req.body?.workspacePath?.trim() || configuredWorkspaceRoot(projectMeta?.knowledgeRoot || process.cwd());
      const brainDir = rootDir.endsWith(".brain") ? rootDir : join(rootDir, ".brain");
      if (!existsSync(brainDir)) {
        return { projectId: req.params.projectId, brainDir, syncedCount: 0, items: [], message: "Diretório .brain não encontrado neste workspace." };
      }

      const mdFiles: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else if (entry.toLowerCase().endsWith(".md")) mdFiles.push(full);
        }
      };
      walk(brainDir);

      const synced: KnowledgeItem[] = [];
      for (const filePath of mdFiles.slice(0, 100)) {
        const rel = relative(brainDir, filePath).replace(/\\/g, "/");
        const raw = readFileSync(filePath, "utf8");
        const cleanContent = await redactPiiWithAiWorker(raw);
        assertSecretScanClean(scanForSecrets(cleanContent), rel);

        const inferredType: KnowledgeItem["type"] = rel.startsWith("skills/")
          ? "skill"
          : rel.startsWith("specs/")
            ? "spec"
            : rel.includes("business")
              ? "business_rule"
              : rel.includes("architecture")
                ? "architecture_decision"
                : "document";

        const id = `BRAIN-${rel.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 48)}`;
        const existing = pgRetrieval
          ? await pgRetrieval.getItem(ctx, req.params.projectId, id)
          : retrieval.getItem(ctx, req.params.projectId, id);
        const now = new Date().toISOString();
        const item: KnowledgeItem = {
          id,
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          domainId: 2,
          type: inferredType,
          title: rel.replace(/\.md$/i, ""),
          content: cleanContent,
          status: existing?.status ?? "approved",
          sourceId: "brain-sync",
          sourceOrigin: "internal",
          sourceKind: "git",
          sourceVersion: existing ? `v${existing.version + 1}` : "v1",
          sourceUri: `.brain/${rel}`,
          version: existing ? existing.version + 1 : 1,
          contentHash: createHash("sha256").update(cleanContent).digest("hex"),
          ownerId: ctx.actorId,
          confidence: 1,
          trustLevel: "verified",
          isInferred: false,
          tags: [inferredType, "brain-sync"],
          relatedIds: existing?.relatedIds ?? [],
          accessPolicyId: existing?.accessPolicyId ?? "internal-project",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        await upsertKnowledgeItem(ctx, item);
        synced.push(item);
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "brain_sync",
        targetId: req.params.projectId,
        metadata: { syncedCount: synced.length, brainDir }
      });

      return { projectId: req.params.projectId, brainDir, syncedCount: synced.length, items: synced };
    }
  );
}

