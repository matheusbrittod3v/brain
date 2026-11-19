import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import type { IntentType } from "@brain/context-engine";
import { paginateCursor } from "@brain/core";
import { hashWorkspaceSources } from "@brain/workspace-detection";
import { describeMcpTool, type McpConnectionProfileName } from "../connection-profile.js";
import {
  computeKnowledgeQuality,
  extractDiagrams,
  inferKnowledgeFormat,
  inferKnowledgeLayer,
  materializeKnowledgeItemVersion,
  okJson
} from "../helpers.js";
import type { BrainRuntime } from "../runtime.js";

export function registerCoreRetrievalTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
) {
  server.tool(
    "brain_bootstrap_project",
    describeMcpTool(profile, "Identifica ou cadastra um projeto/branch e retorna visão geral, regras iniciais e alertas."),
    {
      projectId: z.string().min(1),
      workspacePath: z.string().optional(),
      branch: z.string().optional(),
      createIfMissing: z.boolean().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      knowledgeRoot: z.string().optional()
    },
    async ({ projectId, workspacePath, branch, createIfMissing, name, description, knowledgeRoot }) => {
      assertProjectAccess(ctx, projectId);
      let created = false;
      let project: { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string } | undefined;

      if (createIfMissing || name) {
        const resolvedName = name?.trim() || projectId;
        const resolvedRoot = knowledgeRoot?.trim() || ".brain/";
        if (runtime.opRepo) {
          const reg = await runtime.opRepo.registerProject(ctx, {
            projectId,
            name: resolvedName,
            description: description?.trim() || undefined,
            knowledgeRoot: resolvedRoot
          });
          created = reg.created;
          project = reg.project;
        } else {
          const store = runtime.registeredProjects ?? new Map();
          const key = `${ctx.tenantId}:${projectId}`;
          const existing = store.get(key);
          if (existing) {
            project = {
              ...existing,
              name: resolvedName,
              description: description?.trim() || existing.description,
              knowledgeRoot: resolvedRoot
            };
            store.set(key, project);
          } else {
            created = true;
            project = {
              projectId,
              tenantId: ctx.tenantId,
              name: resolvedName,
              description: description?.trim() || undefined,
              knowledgeRoot: resolvedRoot,
              createdAt: new Date().toISOString()
            };
            store.set(key, project);
          }
        }
        await runtime.audit.record({
          tenantId: ctx.tenantId,
          projectId,
          accessPolicyId: auditPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: created ? "create" : "update",
          targetType: "project",
          targetId: projectId,
          metadata: { name: project?.name ?? resolvedName, knowledgeRoot: project?.knowledgeRoot ?? resolvedRoot }
        });
      } else if (runtime.opRepo) {
        const list = await runtime.opRepo.listProjects(ctx);
        project = list.find((p) => p.projectId === projectId);
      } else if (runtime.registeredProjects) {
        project = runtime.registeredProjects.get(`${ctx.tenantId}:${projectId}`);
      }

      const overview = await runtime.retrieval.search(ctx, { projectId, query: "vision overview", domains: [1, 3, 4], limit: 5 });
      return okJson({
        projectId,
        workspacePath: workspacePath ?? ".",
        branch: branch ?? "main",
        created,
        ...(project ? { project } : {}),
        overviewItems: overview.map((h) => ({ id: h.item.id, title: h.item.title, status: h.item.status }))
      });
    }
  );

  server.tool(
    "brain_context_build",
    describeMcpTool(profile, "Monta um Context Pack otimizado em tokens (regras, ADRs, código, testes, citações)."),
    {
      projectId: z.string(),
      task: z.string(),
      intent: z.enum(["implement", "debug", "impact", "review", "business_qa", "onboarding"]).optional(),
      includeDomains: z.array(z.number()).optional(),
      tokenBudget: z.number().optional(),
      explain: z.boolean().optional(),
      sessionId: z.string().min(1).max(128).optional(),
      taskId: z.string().optional()
    },
    async ({ projectId, task, intent, includeDomains, tokenBudget, explain, sessionId: requestedSessionId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      const sessionId = requestedSessionId ?? randomUUID();
      await runtime.audit.record({
        tenantId: ctx.tenantId, projectId, accessPolicyId: auditPolicyId, actorId: ctx.actorId, actorType: ctx.actorType,
        action: "search", targetType: "context_pack", metadata: { task, intent, includeDomains }
      });
      const pack = await runtime.contextEngine.buildContextPack(ctx, {
        projectId,
        task,
        intent: intent as IntentType | undefined,
        includeDomains,
        tokenBudget,
        explain,
        sessionId,
        memories: runtime.memory ? await runtime.memory.listVisible(ctx, projectId, sessionId) : []
      });
      const workspaceRoot = runtime.workspaceRoots?.[projectId] ?? runtime.workspaceRoot ?? process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd();
      const sourceHashes = await hashWorkspaceSources(workspaceRoot, pack.sources.map((source) => source.sourceUri));
      const hashByUri = new Map(sourceHashes.map((source) => [source.sourceUri, source.sourceHash]));
      const hitRate = runtime.opRepo ? await runtime.opRepo.recordContextDelivery(ctx, projectId, sessionId, pack.sources.map((source) => ({
        itemId: source.id,
        accessPolicyId: source.accessPolicyId,
        sourceUri: source.sourceUri,
        sourceHash: hashByUri.get(source.sourceUri),
        taskId
      }))) : { sessionId, hits: 0, itemsSent: pack.sources.length, rate: null };
      return okJson({ ...pack, sessionId, hitRate });
    }
  );

  server.tool(
    "brain_search",
    describeMcpTool(profile, "Busca híbrida direta (lexical + grafo + filtros de domínio) com paginação."),
    {
      projectId: z.string(),
      query: z.string(),
      domains: z.array(z.number()).optional(),
      atDate: z.string().optional(),
      limit: z.number().optional(),
      cursor: z.string().optional()
    },
    async ({ projectId, query, domains, atDate, limit, cursor }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query, domains, atDate, limit: 100 });
      const mapped = hits.map((h) => {
        const layer = inferKnowledgeLayer(h.item);
        const format = inferKnowledgeFormat(h.item);
        const quality = computeKnowledgeQuality(h.item);
        const diagrams = extractDiagrams(h.item.content);
        return {
          id: h.item.id,
          title: h.item.title,
          type: h.item.type,
          status: h.item.status,
          layer,
          format,
          qualityScore: quality.score,
          qualityGrade: quality.grade,
          tags: h.item.tags,
          hasDiagrams: diagrams.length > 0,
          summary: h.item.summary ?? h.item.content.slice(0, 220),
          score: h.score,
          sourceUri: h.item.sourceUri
        };
      });
      return okJson(paginateCursor(mapped, limit ?? 20, cursor));
    }
  );

  server.tool(
    "brain_get_layered_knowledge",
    describeMcpTool(profile, "Retorna conhecimento estruturado por camada (arquitetura, negócio, código, produto, operação), formato, qualidade e diagramas/topologias extraídos."),
    {
      projectId: z.string(),
      layer: z.enum(["all", "architecture", "business", "code", "product", "operations", "general"]).optional(),
      format: z.enum(["all", "markdown", "mermaid", "topology", "flow", "code"]).optional(),
      query: z.string().optional(),
      minQuality: z.number().min(0).max(100).optional(),
      limit: z.number().optional()
    },
    async ({ projectId, layer = "all", format = "all", query = "", minQuality = 0, limit = 30 }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query, limit: 100 });
      const enriched = hits
        .map((h) => {
          const itemLayer = inferKnowledgeLayer(h.item);
          const itemFormat = inferKnowledgeFormat(h.item);
          const quality = computeKnowledgeQuality(h.item);
          const diagrams = extractDiagrams(h.item.content);
          return {
            id: h.item.id,
            title: h.item.title,
            type: h.item.type,
            status: h.item.status,
            layer: itemLayer,
            format: itemFormat,
            qualityScore: quality.score,
            qualityGrade: quality.grade,
            tags: h.item.tags,
            diagrams,
            content: h.item.content,
            sourceUri: h.item.sourceUri
          };
        })
        .filter((i) => (layer === "all" || i.layer === layer) && (format === "all" || i.format === format) && i.qualityScore >= minQuality)
        .slice(0, limit);

      const byLayer: Record<string, number> = {};
      for (const item of enriched) {
        byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1;
      }
      return okJson({ projectId, total: enriched.length, byLayer, items: enriched });
    }
  );

  server.tool(
    "brain_knowledge_get",
    describeMcpTool(profile, "Obtém um KnowledgeItem específico por ID e suas relações seguras no grafo."),
    {
      projectId: z.string(),
      id: z.string(),
      version: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
      depth: z.number().optional(),
      sessionId: z.string().min(1).max(128).optional()
    },
    async ({ projectId, id, version, depth, sessionId }) => {
      assertProjectAccess(ctx, projectId);
      const item = await runtime.retrieval.getItem(ctx, projectId, id);
      if (!item) return okJson({ error: "BRAIN_ERR_NOT_FOUND", message: `Item '${id}' não encontrado ou sem permissão.` });
      let selectedItem = item;
      if (version !== undefined) {
        if (!runtime.knowledge) {
          return okJson({ error: "BRAIN_ERR_STORAGE_UNAVAILABLE", message: "O histórico de versões não está configurado neste runtime." });
        }
        const versions = await runtime.knowledge.listVersions(ctx, projectId, id);
        const selectedVersion = typeof version === "number"
          ? versions.find((candidate) => candidate.version === version)
          : /^\d+$/.test(version)
            ? versions.find((candidate) => candidate.version === Number(version))
            : versions.find((candidate) => candidate.sourceVersion === version);
        if (!selectedVersion) {
          return okJson({ error: "BRAIN_ERR_NOT_FOUND", message: `Versão '${version}' do item '${id}' não encontrada ou sem permissão.` });
        }
        selectedItem = materializeKnowledgeItemVersion(item, selectedVersion);
      }
      const relations = await runtime.graph.traverseRelated(ctx, { projectId, itemId: id }, depth ?? 2);
      const hitRate = sessionId && runtime.opRepo ? (await runtime.opRepo.recordContextEvidence(ctx, projectId, sessionId, [id], "read")).rate : null;
      if (hitRate) runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      return okJson({ item: selectedItem, relations, ...(hitRate ? { hitRate } : {}) });
    }
  );

  server.tool(
    "brain_get_active_rules",
    describeMcpTool(profile, "Lista regras de negócio e padrões vigentes do projeto."),
    {
      projectId: z.string(),
      query: z.string().optional(),
      serviceId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().optional(),
      cursor: z.string().optional()
    },
    async ({ projectId, query, serviceId, tags, limit, cursor }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: query ?? serviceId ?? "regra", domains: [2, 4, 7], limit: 100 });
      const filtered = tags?.length
        ? hits.filter((h) => tags.some((tag) => h.item.tags.includes(tag)))
        : hits;
      const items = filtered.map((h) => h.item);
      const page = paginateCursor(items, limit ?? 10, cursor);
      return okJson({
        rules: page.items,
        adrs: page.items.filter((i) => i.type === "architecture_decision"),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      });
    }
  );

  server.tool(
    "brain_find_related_code",
    describeMcpTool(profile, "Localiza símbolos, arquivos e testes relacionados a uma regra ou requisito."),
    { projectId: z.string(), targetId: z.string(), limit: z.number().optional(), cursor: z.string().optional() },
    async ({ projectId, targetId, limit, cursor }) => {
      assertProjectAccess(ctx, projectId);
      const relations = await runtime.graph.traverseRelated(ctx, { projectId, itemId: targetId }, 2);
      const page = paginateCursor(relations, limit ?? 20, cursor);
      const related = await Promise.all(page.items.map(async (hit) => {
        const item = await runtime.retrieval.getItem(ctx, hit.projectId, hit.itemId);
        return { ...hit, ...(item ? { item: { id: item.id, title: item.title, type: item.type, sourceUri: item.sourceUri } } : {}) };
      }));
      const tests = related.filter((hit) => hit.item?.type === "test" || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(hit.item?.sourceUri ?? ""));
      const symbols = related.filter((hit) => hit.item?.type === "code_symbol");
      const testKeys = new Set(tests.map((hit) => `${hit.projectId}:${hit.itemId}`));
      const files = related.filter((hit) => !testKeys.has(`${hit.projectId}:${hit.itemId}`) && hit.item?.type !== "code_symbol" && /\.[cm]?[jt]sx?$|\.(?:py|go|java|rs)$/.test(hit.item?.sourceUri ?? ""));
      return okJson({ projectId, targetId, related, symbols, files, tests, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
    }
  );

  server.tool(
    "brain_resolve_workspace_project",
    describeMcpTool(profile, "Detecta automaticamente o projectId a partir do diretório de trabalho (cwd) ou git remote, sem depender de IDs no .env."),
    {
      workspacePath: z.string().optional(),
      repoUrl: z.string().optional()
    },
    async ({ workspacePath, repoUrl }) => {
      const resolvedPath = workspacePath?.trim() || runtime.workspaceRoot || process.cwd();
      let detectedRepoUrl = repoUrl?.trim();
      if (!detectedRepoUrl) {
        try {
          const gitConfig = await readFile(join(resolvedPath, ".git", "config"), "utf8");
          const match = gitConfig.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
          if (match?.[1]) detectedRepoUrl = match[1].trim();
        } catch {
          // .git/config not found in workspacePath
        }
      }

      const dbMatch = runtime.opRepo
        ? await runtime.opRepo.findProjectByWorkspace(ctx.tenantId, { workspaceRoot: resolvedPath, repoUrl: detectedRepoUrl })
        : null;

      if (dbMatch && ctx.allowedProjects.includes(dbMatch.projectId)) {
        return okJson({
          matched: true,
          projectId: dbMatch.projectId,
          name: dbMatch.name,
          matchedBy: dbMatch.matchedBy,
          workspacePath: resolvedPath,
          repoUrl: detectedRepoUrl ?? null,
          allowedProjects: ctx.allowedProjects
        });
      }

      const folderName = resolvedPath.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
      const fallbackId = ctx.allowedProjects.find((id) => id.toLowerCase() === folderName) ?? null;

      return okJson({
        matched: Boolean(fallbackId),
        projectId: fallbackId,
        matchedBy: fallbackId ? "allowed_projects_folder" : "none",
        workspacePath: resolvedPath,
        repoUrl: detectedRepoUrl ?? null,
        allowedProjects: ctx.allowedProjects
      });
    }
  );
}

