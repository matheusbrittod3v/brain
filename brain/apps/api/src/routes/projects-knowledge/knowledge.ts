import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { BrainError, type KnowledgeItem } from "@brain/core";
import { extractMarkdownFromUrl, scanForSecrets } from "@brain/ingestion";
import { parseSpecTasksChecklist } from "@brain/task-engine";
import { assertSecretScanClean, redactPiiWithAiWorker } from "../../services/ai-worker.js";
import type { ProjectsKnowledgeDeps } from "./types.js";

export function registerKnowledgeItemRoutes(app: FastifyInstance, deps: ProjectsKnowledgeDeps) {
  const {
    authenticateProjectRequest,
    enforcePolicy,
    recordAudit,
    upsertKnowledgeItem,
    opRepo,
    pgRetrieval,
    retrieval,
    pgKnowledge,
    pgGraph,
    graph,
    pgApprovals,
    runner
  } = deps;

  app.post<{
    Params: { projectId: string };
    Body: {
      id?: string;
      title: string;
      type?: KnowledgeItem["type"];
      content: string;
      summary?: string;
      accessPolicyId?: string;
      tags?: string[];
      status?: KnowledgeItem["status"];
      domainId?: number;
      globalOrg?: boolean;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/v1/projects/:projectId/knowledge",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          id: Type.Optional(Type.String({ minLength: 1 })),
          title: Type.String({ minLength: 1 }),
          type: Type.Optional(Type.String()),
          content: Type.String({ minLength: 1 }),
          summary: Type.Optional(Type.String()),
          accessPolicyId: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String())),
          status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("deprecated"), Type.Literal("superseded")])),
          domainId: Type.Optional(Type.Integer({ minimum: 1 })),
          globalOrg: Type.Optional(Type.Boolean()),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const targetProjectId =
        req.body.globalOrg && (ctx.roles.includes("admin") || ctx.allowedProjects.includes("__org__"))
          ? "__org__"
          : req.params.projectId;
      const effectiveCtx =
        targetProjectId === "__org__"
          ? { ...ctx, allowedProjects: [...new Set([...ctx.allowedProjects, "__org__"])] }
          : ctx;
      const accessPolicyId = req.body.accessPolicyId?.trim() || "internal-project";
      const domainId = req.body.domainId ?? 2;
      await enforcePolicy(effectiveCtx, { projectId: targetProjectId, accessPolicyId, action: "write", domainId });

      const cleanContent = await redactPiiWithAiWorker(req.body.content);
      assertSecretScanClean(scanForSecrets(cleanContent), req.body.id || req.body.title);

      const now = new Date().toISOString();
      const itemType = (req.body.type?.trim() || "document") as KnowledgeItem["type"];
      const prefix = itemType === "skill" ? "SKILL" : itemType === "spec" ? "SPEC" : "DOC";
      const itemId =
        req.body.id?.trim() ||
        `${prefix}-${req.body.title
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32)}-${randomUUID().slice(0, 4).toUpperCase()}`;

      const existing = pgRetrieval
        ? await pgRetrieval.getItem(effectiveCtx, targetProjectId, itemId)
        : retrieval.getItem(effectiveCtx, targetProjectId, itemId);

      const requestedStatus = req.body.status ?? existing?.status ?? "draft";
      if (requestedStatus === "approved") {
        await enforcePolicy(effectiveCtx, { projectId: targetProjectId, accessPolicyId, action: "approve", domainId });
      }

      const item: KnowledgeItem = {
        id: itemId,
        tenantId: effectiveCtx.tenantId,
        projectId: targetProjectId,
        domainId,
        type: itemType,
        title: req.body.title.trim(),
        content: cleanContent,
        ...(req.body.summary !== undefined ? { summary: req.body.summary } : existing?.summary ? { summary: existing.summary } : {}),
        status: requestedStatus,
        sourceId: "web-hub",
        sourceOrigin: "internal",
        sourceKind: "api",
        sourceVersion: existing ? `v${existing.version + 1}` : "v1",
        sourceUri: itemType === "skill" ? `.brain/skills/${itemId}/SKILL.md` : itemType === "spec" ? `.brain/specs/${itemId}.md` : `.brain/docs/${itemId}.md`,
        version: existing ? existing.version + 1 : 1,
        contentHash: createHash("sha256").update(cleanContent).digest("hex"),
        ownerId: effectiveCtx.actorId,
        confidence: 1,
        trustLevel: requestedStatus === "approved" ? "verified" : "self_authored",
        isInferred: false,
        tags: req.body.tags ?? existing?.tags ?? (itemType === "skill" ? ["skill", "mcp"] : itemType === "spec" ? ["spec", "planning"] : []),
        relatedIds: existing?.relatedIds ?? [],
        accessPolicyId,
        metadata: { ...(existing?.metadata ?? {}), ...(req.body.metadata ?? {}), ...(targetProjectId === "__org__" ? { globalOrg: true } : {}) },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      await upsertKnowledgeItem(effectiveCtx, item);
      await recordAudit(effectiveCtx, {
        tenantId: effectiveCtx.tenantId,
        projectId: targetProjectId,
        accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: existing ? "update" : "create",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { type: item.type, version: item.version, status: item.status }
      });

      return { created: !existing, item };
    }
  );

  app.put<{
    Params: { projectId: string; itemId: string };
    Body: {
      title?: string;
      type?: KnowledgeItem["type"];
      content?: string;
      summary?: string;
      accessPolicyId?: string;
      tags?: string[];
      status?: KnowledgeItem["status"];
      metadata?: Record<string, unknown>;
    };
  }>(
    "/v1/projects/:projectId/knowledge/:itemId",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), itemId: Type.String() }),
        body: Type.Object({
          title: Type.Optional(Type.String({ minLength: 1 })),
          type: Type.Optional(Type.String()),
          content: Type.Optional(Type.String({ minLength: 1 })),
          summary: Type.Optional(Type.String()),
          accessPolicyId: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String())),
          status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("deprecated"), Type.Literal("superseded")])),
          metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const existing = pgRetrieval
        ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.itemId)
        : retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
      if (!existing) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${req.params.itemId}' não encontrado.`, 404);

      const accessPolicyId = req.body.accessPolicyId?.trim() || existing.accessPolicyId;
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId, action: "update", domainId: existing.domainId });
      if (req.body.status === "approved" && existing.status !== "approved") {
        await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId, action: "approve", domainId: existing.domainId });
      }

      const nextContent = req.body.content !== undefined ? await redactPiiWithAiWorker(req.body.content) : existing.content;
      if (req.body.content !== undefined) {
        assertSecretScanClean(scanForSecrets(nextContent), existing.id);
      }

      const updated: KnowledgeItem = {
        ...existing,
        title: req.body.title?.trim() || existing.title,
        type: (req.body.type?.trim() || existing.type) as KnowledgeItem["type"],
        content: nextContent,
        ...(req.body.summary !== undefined ? { summary: req.body.summary } : {}),
        accessPolicyId,
        tags: req.body.tags ?? existing.tags,
        status: req.body.status ?? existing.status,
        version: existing.version + 1,
        sourceVersion: `v${existing.version + 1}`,
        contentHash: createHash("sha256").update(nextContent).digest("hex"),
        metadata: { ...(existing.metadata ?? {}), ...(req.body.metadata ?? {}) },
        updatedAt: new Date().toISOString()
      };

      await upsertKnowledgeItem(ctx, updated);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "knowledge_item",
        targetId: updated.id,
        metadata: { version: updated.version, status: updated.status }
      });

      return { item: updated };
    }
  );

  app.post<{
    Params: { projectId: string; itemId: string };
    Body: { enqueueToRunner?: boolean };
  }>("/v1/projects/:projectId/knowledge/:itemId/plan-tasks", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgRetrieval
      ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.itemId)
      : retrieval.getItem(ctx, req.params.projectId, req.params.itemId);
    if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${req.params.itemId}' não encontrado.`, 404);

    const parsedTasks = parseSpecTasksChecklist(item.content);
    const pendingTasks = parsedTasks.filter((t) => !t.completed);
    const queuedTasks: Array<{ taskId: string; title: string; priority: string }> = [];

    if (req.body?.enqueueToRunner) {
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
      for (const t of pendingTasks.slice(0, 10)) {
        const priority = t.priority === "critical" || t.priority === "high" ? "high" : t.priority === "low" ? "low" : "normal";
        const runnerTask = runner.enqueue(ctx, {
          projectId: req.params.projectId,
          instruction: `[Spec ${item.id} · ${t.section}] ${t.title}`,
          priority
        });
        if (opRepo) await opRepo.saveRunnerTask(ctx, runnerTask);
        queuedTasks.push({ taskId: runnerTask.taskId, title: t.title, priority });
      }
    }

    return {
      projectId: req.params.projectId,
      itemId: item.id,
      tasks: parsedTasks,
      pendingCount: pendingTasks.length,
      queuedTasks
    };
  });

  app.post<{
    Params: { projectId: string };
    Body: { url: string; type?: KnowledgeItem["type"]; accessPolicyId?: string; tags?: string[] };
  }>(
    "/v1/projects/:projectId/ingest-url",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          url: Type.String({ minLength: 8 }),
          type: Type.Optional(Type.String()),
          accessPolicyId: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const accessPolicyId = req.body.accessPolicyId?.trim() || "internal-project";
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId, action: "write", domainId: 2 });

      const extracted = await extractMarkdownFromUrl(req.body.url);
      const cleanContent = await redactPiiWithAiWorker(extracted.markdown);
      assertSecretScanClean(scanForSecrets(cleanContent), extracted.url);

      const now = new Date().toISOString();
      const itemType = (req.body.type?.trim() || "document") as KnowledgeItem["type"];
      const itemId = `URL-${extracted.title
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32)}-${randomUUID().slice(0, 4).toUpperCase()}`;

      const item: KnowledgeItem = {
        id: itemId,
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        domainId: 2,
        type: itemType,
        title: extracted.title,
        content: cleanContent,
        status: "draft",
        sourceId: "url-extractor",
        sourceOrigin: "external_reference",
        sourceKind: "api",
        sourceVersion: "v1",
        sourceUri: extracted.url,
        version: 1,
        contentHash: createHash("sha256").update(cleanContent).digest("hex"),
        ownerId: ctx.actorId,
        confidence: 1,
        trustLevel: "self_authored",
        isInferred: false,
        tags: req.body.tags ?? [itemType, "url-import"],
        relatedIds: [],
        accessPolicyId,
        createdAt: now,
        updatedAt: now
      };

      await upsertKnowledgeItem(ctx, item);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { url: extracted.url, type: item.type }
      });

      return { item };
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
      await enforcePolicy(ctx, {
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
}

