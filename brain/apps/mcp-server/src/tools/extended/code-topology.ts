import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertPolicyAccess, assertProjectAccess, type AuthContext } from "@brain/auth";
import { extractCodeSymbols } from "@brain/code-intelligence";
import type { KnowledgeItem } from "@brain/core";
import { scanForSecrets } from "@brain/ingestion";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { inferKnowledgeFormat, inferKnowledgeLayer, okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

function parseFileFrontmatter(rel: string, content: string): {
  id?: string;
  title?: string;
  type?: KnowledgeItem["type"];
  knowledgeLayer?: string;
} {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = fmMatch ? fmMatch[1]! : /\.(ya?ml)$/i.test(rel) ? content.slice(0, 1500) : "";
  if (!block) return {};
  const pick = (key: string) => {
    const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
  };
  const rawType = pick("type") as KnowledgeItem["type"] | undefined;
  const validTypes = new Set<KnowledgeItem["type"]>([
    "business_rule", "requirement", "feature", "architecture_decision", "code_symbol",
    "test", "service", "api_contract", "event_contract", "task", "process",
    "integration", "risk", "memory", "document", "skill", "spec"
  ]);
  const inferredType = rawType && validTypes.has(rawType)
    ? rawType
    : rel.endsWith("SKILL.md")
      ? "skill"
      : undefined;
  return {
    id: pick("id"),
    title: pick("title"),
    type: inferredType,
    knowledgeLayer: pick("knowledgeLayer")
  };
}

function buildKnowledgeItem(params: {
  id: string;
  tenantId: string;
  projectId: string;
  type: KnowledgeItem["type"];
  title: string;
  content: string;
  sourceUri: string;
  sourceKind: "git" | "agent";
  accessPolicyId: string;
  version?: number;
  metadata?: Record<string, unknown>;
}): KnowledgeItem {
  const now = new Date().toISOString();
  const ver = params.version ?? 1;
  return {
    id: params.id,
    tenantId: params.tenantId,
    projectId: params.projectId,
    domainId: 1,
    type: params.type,
    title: params.title,
    content: params.content,
    status: "approved",
    sourceId: params.id,
    sourceOrigin: "internal",
    sourceKind: params.sourceKind,
    sourceVersion: String(ver),
    sourceUri: params.sourceUri,
    version: ver,
    contentHash: createHash("sha256").update(params.content).digest("hex"),
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: [],
    relatedIds: [],
    accessPolicyId: params.accessPolicyId,
    createdAt: now,
    updatedAt: now,
    metadata: params.metadata
  };
}

async function collectFiles(dir: string, maxFiles = 60): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    if (out.length >= maxFiles) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === ".nuxt" || entry.name === ".output") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(md|ya?ml|ts|tsx|js|jsx|py|go|rs|java)$/i.test(entry.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Registers Git/workspace ingestion, SCIP/AST symbol search, test execution recording,
 * direct knowledge updates, Mermaid topology export, and cross-service contract registration.
 */
export function registerCodeTopologyTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
) {
  server.tool(
    "brain_ingest_git_repo",
    describeMcpTool(profile, "Indexa arquivos de conhecimento e código de um workspace local diretamente no Brain."),
    {
      projectId: z.string().min(1),
      workspacePath: z.string().optional(),
      accessPolicyId: z.string().optional(),
      maxFiles: z.number().min(1).max(200).optional()
    },
    async ({ projectId, workspacePath, accessPolicyId, maxFiles }) => {
      assertProjectAccess(ctx, projectId);
      const policy = accessPolicyId ?? auditPolicyId;
      assertPolicyAccess(ctx, policy);
      const root = workspacePath?.trim() || runtime.workspaceRoot || process.cwd();
      const files = await collectFiles(root, maxFiles ?? 60);
      let indexed = 0;
      let skippedSecrets = 0;

      for (const file of files) {
        const content = await readFile(file, "utf8").catch(() => "");
        if (!content.trim()) continue;
        if (!scanForSecrets(content).clean) {
          skippedSecrets += 1;
          continue;
        }
        const rel = relative(root, file);
        const fm = parseFileFrontmatter(rel, content);
        const id = fm.id || `WS-${rel.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80)}`;
        const itemType: KnowledgeItem["type"] =
          fm.type ?? (rel.endsWith(".md") || rel.endsWith(".yaml") || rel.endsWith(".yml") ? "document" : "code_symbol");
        const trimmedContent = content.slice(0, 12000);
        const targetTitle = fm.title || rel;
        const existing = await runtime.retrieval.getItem(ctx, projectId, id);
        if (existing && existing.content === trimmedContent && existing.title === targetTitle && existing.type === itemType) {
          continue;
        }
        const versions = runtime.knowledge ? await runtime.knowledge.listVersions(ctx, projectId, id).catch(() => []) : [];
        const maxVersion = versions.reduce((m, v) => Math.max(m, v.version), existing?.version ?? 0);
        const item = buildKnowledgeItem({
          id,
          tenantId: ctx.tenantId,
          projectId,
          type: itemType,
          title: targetTitle,
          content: trimmedContent,
          sourceUri: rel,
          sourceKind: "git",
          accessPolicyId: policy,
          version: maxVersion + 1,
          metadata: {
            knowledgeLayer: fm.knowledgeLayer || inferKnowledgeLayer({ type: itemType }),
            format: inferKnowledgeFormat({ content })
          }
        });
        if (runtime.knowledge) await runtime.knowledge.upsertItem(ctx, item);
        if (runtime.retrieval.upsertItem) await runtime.retrieval.upsertItem(item);
        indexed += 1;
      }

      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      return okJson({ projectId, workspacePath: root, scanned: files.length, indexed, skippedSecrets });
    }
  );

  server.tool(
    "brain_code_symbols_search",
    describeMcpTool(profile, "Busca símbolos de código indexados ou extrai símbolos AST de um arquivo local."),
    {
      projectId: z.string().min(1),
      query: z.string().optional(),
      filePath: z.string().optional()
    },
    async ({ projectId, query, filePath }) => {
      assertProjectAccess(ctx, projectId);
      if (filePath) {
        const source = await readFile(filePath, "utf8");
        const symbols = extractCodeSymbols(filePath, source);
        return okJson({ projectId, filePath, symbols });
      }
      const hits = await runtime.retrieval.search(ctx, { projectId, query: query ?? "", limit: 50 });
      const symbols = hits
        .filter((h) => h.item.type === "code_symbol")
        .map((h) => ({ id: h.item.id, title: h.item.title, sourceUri: h.item.sourceUri, score: h.score }));
      return okJson({ projectId, count: symbols.length, symbols });
    }
  );

  server.tool(
    "brain_record_test_result",
    describeMcpTool(profile, "Registra resultado de execução de teste vinculado a regras de negócio."),
    {
      projectId: z.string().min(1),
      suiteName: z.string().min(1),
      testName: z.string().min(1),
      status: z.enum(["passed", "failed", "skipped"]),
      ruleIds: z.array(z.string()).optional(),
      durationMs: z.number().optional()
    },
    async ({ projectId, suiteName, testName, status, ruleIds, durationMs }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        return okJson({ recorded: false, reason: "PostgreSQL operational repository unavailable." });
      }
      await runtime.opRepo.recordTestExecutionResults(ctx, {
        projectId,
        provider: "mcp",
        runId: randomUUID(),
        commitSha: "workspace",
        receivedBy: ctx.actorId,
        executedAt: new Date(),
        results: [
          {
            testItemId: `${suiteName}:${testName}`,
            accessPolicyId: auditPolicyId,
            status,
            durationMs: durationMs ?? null
          }
        ]
      });
      return okJson({ recorded: true, projectId, suiteName, testName, status });
    }
  );

  server.tool(
    "brain_update_knowledge",
    describeMcpTool(profile, "Atualiza ou arquiva/deprecia diretamente um item de conhecimento existente."),
    {
      projectId: z.string().min(1),
      itemId: z.string().min(1),
      title: z.string().optional(),
      content: z.string().optional(),
      status: z.enum(["draft", "approved", "deprecated", "superseded"]).optional()
    },
    async ({ projectId, itemId, title, content, status }) => {
      assertProjectAccess(ctx, projectId);
      const existing = await runtime.retrieval.getItem(ctx, projectId, itemId);
      if (!existing) {
        return okJson({ updated: false, error: "Item não encontrado." });
      }
      assertPolicyAccess(ctx, existing.accessPolicyId);
      const updated: KnowledgeItem = {
        ...existing,
        title: title ?? existing.title,
        content: content ?? existing.content,
        status: (status as KnowledgeItem["status"]) ?? existing.status,
        version: existing.version + 1,
        updatedAt: new Date().toISOString()
      };
      if (runtime.knowledge) await runtime.knowledge.upsertItem(ctx, updated);
      if (runtime.retrieval.upsertItem) await runtime.retrieval.upsertItem(updated);
      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      return okJson({ updated: true, item: updated });
    }
  );

  server.tool(
    "brain_export_topology_diagram",
    describeMcpTool(profile, "Gera diagrama Mermaid e nós/arestas da topologia de conhecimento por camada."),
    {
      projectId: z.string().min(1),
      layer: z.enum(["all", "architecture", "business", "code", "flows", "data"]).optional()
    },
    async ({ projectId, layer = "all" }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 100 });
      const filtered = hits
        .map((h) => h.item)
        .filter((item) => layer === "all" || (item.metadata as Record<string, unknown> | undefined)?.knowledgeLayer === layer);

      const lines = ["flowchart LR"];
      for (const item of filtered.slice(0, 30)) {
        const safeId = item.id.replace(/[^a-zA-Z0-9_]/g, "_");
        const safeTitle = item.title.replace(/"/g, "'").slice(0, 48);
        lines.push(`  ${safeId}["${safeTitle}"]`);
      }

      const edges: Array<{ from: string; to: string; relationType: string }> = [];
      for (const item of filtered.slice(0, 20)) {
        const rels = await Promise.resolve(runtime.graph.traverseRelated(ctx, { projectId, itemId: item.id }, 1)).catch(() => []);
        for (const r of rels) {
          if (r.projectId !== projectId) continue;
          edges.push({ from: item.id, to: r.itemId, relationType: r.via });
          const fromSafe = item.id.replace(/[^a-zA-Z0-9_]/g, "_");
          const toSafe = r.itemId.replace(/[^a-zA-Z0-9_]/g, "_");
          lines.push(`  ${fromSafe} -->|${r.via}| ${toSafe}`);
        }
      }

      return okJson({
        projectId,
        layer,
        nodesCount: filtered.length,
        edgesCount: edges.length,
        mermaid: lines.join("\n"),
        edges
      });
    }
  );

  server.tool(
    "brain_cross_service_register",
    describeMcpTool(profile, "Registra um contrato OpenAPI / AsyncAPI / GraphQL / gRPC para análise cross-service."),
    {
      projectId: z.string().min(1),
      serviceName: z.string().min(1),
      protocol: z.enum(["openapi", "asyncapi", "graphql", "grpc"]),
      specContent: z.string().min(1),
      accessPolicyId: z.string().optional()
    },
    async ({ projectId, serviceName, protocol, specContent, accessPolicyId }) => {
      assertProjectAccess(ctx, projectId);
      const policy = accessPolicyId ?? auditPolicyId;
      assertPolicyAccess(ctx, policy);
      const id = `CONTRACT-${serviceName.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${protocol}`;
      const item = buildKnowledgeItem({
        id,
        tenantId: ctx.tenantId,
        projectId,
        type: protocol === "asyncapi" ? "event_contract" : "api_contract",
        title: `${serviceName} (${protocol.toUpperCase()})`,
        content: specContent,
        sourceUri: `contracts/${serviceName}.${protocol}`,
        sourceKind: "agent",
        accessPolicyId: policy,
        metadata: {
          serviceName,
          protocol,
          knowledgeLayer: "architecture",
          format: inferKnowledgeFormat({ content: specContent })
        }
      });
      if (runtime.knowledge) await runtime.knowledge.upsertItem(ctx, item);
      if (runtime.retrieval.upsertItem) await runtime.retrieval.upsertItem(item);
      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      return okJson({ registered: true, contract: item });
    }
  );
}
