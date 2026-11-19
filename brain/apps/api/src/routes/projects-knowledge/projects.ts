import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import { assertPermission, authenticateRequest, hasPermission, usersStore, type AuthContext } from "@brain/auth";
import { BrainError, paginateCursor, type KnowledgeItem } from "@brain/core";
import { createDatabaseClient, projects as projectsTable } from "@brain/database";
import { asc, eq } from "drizzle-orm";
import { scanForSecrets } from "@brain/ingestion";
import { assertSecretScanClean, redactPiiWithAiWorker, rerankWithAiWorker } from "../../services/ai-worker.js";
import { configuredWorkspaceRoot } from "../../services/jobs.js";
import { recordZeroHitQuery } from "../evolution-priorities.js";
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
    authRepo,
    pgRetrieval,
    retrieval
  } = deps;

  const systemDb = process.env.DATABASE_SYSTEM_URL ? createDatabaseClient(process.env.DATABASE_SYSTEM_URL).db : undefined;

  app.get<{ Querystring: { scope?: string } }>("/v1/projects", async (req) => {
    const rawCtx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
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
    if (req.query.scope === "catalog" && systemDb) {
      const rows = await systemDb
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.tenantId, baseCtx.tenantId))
        .orderBy(asc(projectsTable.id));
      return {
        projects: rows.map((row) => ({
          projectId: row.id,
          tenantId: row.tenantId,
          name: row.name,
          description: row.description ?? undefined,
          knowledgeRoot: row.knowledgeRoot,
          isShared: Boolean(row.isShared),
          createdAt: row.createdAt.toISOString()
        }))
      };
    }
    const ctx = opRepo
      ? await opRepo.resolveDynamicMcpScope(baseCtx, freshUser ? [] : allowedProjects, allowedPolicies, systemDb)
      : baseCtx;
    const projects = opRepo
      ? await opRepo.listProjects(ctx)
      : [...registeredProjects.values()].filter(
          (p) => p.tenantId === ctx.tenantId && (ctx.allowedProjects.includes("*") || ctx.allowedProjects.includes(p.projectId))
        );
    return { projects };
  });

  app.get("/v1/projects/shared", async (req) => {
    const rawCtx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const dbUser = authRepo ? await authRepo.findUserById(rawCtx.actorId) : null;
    const memUser = !dbUser && rawCtx.actorId !== "local-dev" ? usersStore.getUserById(rawCtx.actorId) : null;
    const freshUser = dbUser ?? memUser;
    const ctx: AuthContext = freshUser
      ? {
          ...rawCtx,
          roles: freshUser.roles,
          allowedProjects: freshUser.allowedProjects,
          allowedPolicies: freshUser.allowedPolicies
        }
      : rawCtx;
    assertPermission(ctx, "projects:shared:read");
    const sharedProjects = opRepo ? await opRepo.listSharedProjects(ctx.tenantId, systemDb) : [];
    const enriched = await Promise.all(
      sharedProjects.map(async (proj) => {
        const sharedCtx: AuthContext = {
          ...ctx,
          allowedProjects: [...new Set([...ctx.allowedProjects, proj.projectId])]
        };
        const hits = await queryAwareRetrieval
          .search(sharedCtx, { projectId: proj.projectId, query: "", limit: 200 })
          .catch(() => []);
        const items = hits.map((h) => h.item).filter((i) => i.status !== "deprecated");
        return {
          ...proj,
          counts: {
            total: items.length,
            skills: items.filter((i) => i.type === "skill").length,
            rules: items.filter((i) => i.type === "business_rule").length,
            specs: items.filter((i) => i.type === "spec" || i.type === "architecture_decision").length
          }
        };
      })
    );
    return { projects: enriched };
  });

  app.put<{ Params: { projectId: string }; Body: { isShared: boolean } }>(
    "/v1/projects/:projectId/share",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "projects:share");
      const isShared = Boolean(req.body?.isShared);
      const updated = opRepo
        ? await opRepo.setProjectShared(ctx, req.params.projectId, isShared, systemDb)
        : null;
      const key = `${ctx.tenantId}:${req.params.projectId}`;
      const existing = registeredProjects.get(key);
      if (existing) {
        registeredProjects.set(key, { ...existing, isShared } as typeof existing);
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "project_share",
        targetId: req.params.projectId,
        metadata: { isShared }
      }).catch(() => undefined);
      return { projectId: req.params.projectId, isShared, project: updated };
    }
  );

  app.post<{ Body: { projectId: string; name?: string; description?: string; knowledgeRoot?: string; isShared?: boolean } }>(
    "/v1/projects",
    async (req) => {
      const projectId = req.body.projectId?.trim();
      if (!projectId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "projectId deve usar slug minúsculo alfanumérico/hífens (ex.: 'billing-api').", 400);
      }
      const ctx = await authenticateProjectRequest(req.headers.authorization, projectId);
      if (req.body.isShared) {
        assertPermission(ctx, "projects:share");
      }
      await enforceOpa(ctx, { projectId, accessPolicyId: "internal-project", action: "write" });
      const name = req.body.name?.trim() || projectId;
      const description = req.body.description?.trim() || undefined;
      const knowledgeRoot = req.body.knowledgeRoot?.trim() || ".brain/";
      const isShared = req.body.isShared !== undefined ? Boolean(req.body.isShared) : undefined;

      const result = opRepo
        ? await opRepo.registerProject(ctx, { projectId, name, description, knowledgeRoot, isShared })
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

  app.post<{ Params: { projectId: string }; Body: { query: string; domains?: number[]; limit?: number; cursor?: string; atDate?: string; includeShared?: boolean; explain?: boolean } }>(
    "/v1/projects/:projectId/search",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const { query, domains, limit, cursor, atDate, includeShared } = req.body;
      const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query, domains, atDate, limit: 100, explain: true });
      const buildExplain = (h: (typeof hits)[number]) => {
        const exp = (h as { explain?: { lexicalScore?: number; vectorScore?: number; rrfScore?: number; graphProximity?: number; authorityWeight?: number; recencyDecay?: number } }).explain;
        const reasons: Array<"textual" | "semantic" | "graph"> = [];
        if ((exp?.lexicalScore ?? 0) > 0.05) reasons.push("textual");
        if ((exp?.vectorScore ?? 0) > 0.25) reasons.push("semantic");
        if ((exp?.graphProximity ?? 0) > 0) reasons.push("graph");
        if (reasons.length === 0) reasons.push("textual");
        return {
          lexicalScore: Number((exp?.lexicalScore ?? 0).toFixed(3)),
          vectorScore: Number((exp?.vectorScore ?? 0).toFixed(3)),
          rrfScore: Number((exp?.rrfScore ?? h.score).toFixed(3)),
          graphProximity: Number((exp?.graphProximity ?? 0).toFixed(3)),
          authorityWeight: Number((exp?.authorityWeight ?? 1).toFixed(2)),
          recencyDecay: Number((exp?.recencyDecay ?? 1).toFixed(2)),
          matchReasons: reasons
        };
      };
      const mapped: Array<KnowledgeItem & { score: number; sharedFromProjectId?: string; explain?: ReturnType<typeof buildExplain> }> = hits.map((h) => ({
        ...h.item,
        score: h.score,
        explain: buildExplain(h)
      }));

      if (includeShared !== false && opRepo && hasPermission(ctx, "projects:shared:read")) {
        const sharedProjects = await opRepo.listSharedProjects(ctx.tenantId, systemDb);
        for (const sp of sharedProjects) {
          if (sp.projectId === req.params.projectId) continue;
          const sharedCtx: AuthContext = {
            ...ctx,
            allowedProjects: [...new Set([...ctx.allowedProjects, sp.projectId])]
          };
          const sharedHits = await queryAwareRetrieval
            .search(sharedCtx, { projectId: sp.projectId, query, domains, atDate, limit: 50, explain: true })
            .catch(() => []);
          for (const sh of sharedHits) {
            if (!mapped.some((m) => m.id === sh.item.id && m.projectId === sh.item.projectId)) {
              mapped.push({ ...sh.item, score: sh.score, sharedFromProjectId: sp.projectId, explain: buildExplain(sh) });
            }
          }
        }
      }

      if (mapped.length === 0 && query.trim().length > 0) {
        recordZeroHitQuery(req.params.projectId, query, ctx.actorId);
      }

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

    const sharedSkills: Array<KnowledgeItem & { scope: "org" | "shared"; sharedFromProjectId?: string }> = [];
    if (opRepo && hasPermission(ctx, "projects:shared:read")) {
      const sharedProjects = await opRepo.listSharedProjects(ctx.tenantId, systemDb);
      for (const sp of sharedProjects) {
        if (sp.projectId === req.params.projectId) continue;
        const sharedCtx: AuthContext = {
          ...ctx,
          allowedProjects: [...new Set([...ctx.allowedProjects, sp.projectId])]
        };
        const spHits = await queryAwareRetrieval
          .search(sharedCtx, { projectId: sp.projectId, query: "", limit: 200 })
          .catch(() => []);
        for (const h of spHits) {
          if (h.item.type === "skill" && h.item.status !== "deprecated") {
            sharedSkills.push({ ...h.item, scope: "shared" as const, sharedFromProjectId: sp.projectId });
          }
        }
      }
    }
    return { projectId: req.params.projectId, skills: [...projectSkills, ...sharedSkills] };
  });

  app.post<{ Params: { projectId: string }; Body: { workspacePath?: string } }>(
    "/v1/projects/:projectId/brain/sync",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write", domainId: 2 });

      const projectMeta = registeredProjects.get(`${ctx.tenantId}:${req.params.projectId}`);
      let rootDir = req.body?.workspacePath?.trim() || configuredWorkspaceRoot(projectMeta?.knowledgeRoot || process.cwd());
      if (!existsSync(join(rootDir, ".brain")) && existsSync(join(rootDir, "../../.brain"))) {
        rootDir = join(rootDir, "../..");
      }
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
          else if (
            entry.toLowerCase().endsWith(".md") ||
            entry.toLowerCase().endsWith(".yaml") ||
            entry.toLowerCase().endsWith(".yml")
          ) mdFiles.push(full);
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

