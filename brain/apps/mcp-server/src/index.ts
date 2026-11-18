#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertPolicyAccess, assertProjectAccess, type AuthContext } from "@brain/auth";
import { evaluateArchitectureChange, type ArchitectureImportEdge } from "@brain/architecture-guardian";
import { evaluateBusinessRuleCompliance } from "@brain/business-rule-guardian";
import { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import { extractFileDependencies } from "@brain/code-intelligence";
import { BrainError, paginateCursor, type KnowledgeItem } from "@brain/core";
import { analyzeDistributedImpact, type AnalyzeDistributedImpactOptions } from "@brain/impact-analysis";
import { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import { createDatabaseClient, PgOperationalRepository } from "@brain/database";
import { findChangedWorkspaceSources, hashWorkspaceSources } from "@brain/workspace-detection";
import { parseKnowledgeFile } from "@brain/knowledge";
import { registerExtendedMcpTools } from "./extended-tools.js";
import { describeMcpTool, MCP_CONNECTION_PROFILES, type McpConnectionProfileName } from "./connection-profile.js";
import { PostgresMemoryManager } from "@brain/memory";
import { PostgresKnowledgeRepository, type KnowledgeItemVersion, type KnowledgeRepository } from "@brain/knowledge";
import { KnowledgeGraphStore, PostgresGraphStore, type GraphStoreContract } from "@brain/graph";
import {
  HybridRetrievalEngine,
  PostgresRetrievalEngine,
  ValkeyRetrievalCache,
  type SearchHit,
  type SearchQuery
} from "@brain/retrieval";
import {
  ContextEngine,
  type AsyncContextEngine,
  type BuildContextPackOptions,
  type ContextPack,
  type IntentType,
  type RetrievalEngineContract
} from "@brain/context-engine";
import { HandoffStore } from "@brain/agent-handoff";
import { BrainRunnerQueue } from "@brain/agent-runner";
import { createRunnerSchedule, type RunnerSchedulePayload } from "./runner-schedules.js";

export { cancelRunnerSchedule, createRunnerSchedule, listRunnerSchedules } from "./runner-schedules.js";
import {
  createAppPostgresClient,
  createPostgresAuditLogger,
  type AppPostgresClient,
  type AuditLogger,
  type RlsSessionContext
} from "@brain/audit-engine";

export type McpRetrievalContract = RetrievalEngineContract & {
  getItem(
    ctx: AuthContext,
    projectId: string,
    id: string
  ): KnowledgeItem | undefined | Promise<KnowledgeItem | undefined>;
  search(
    ctx: AuthContext,
    q: SearchQuery
  ): readonly SearchHit[] | PromiseLike<readonly SearchHit[]>;
  recordHitBoost(projectId: string, itemId: string, delta?: number): void;
  invalidateCache?(tenantId: string, projectId?: string): void;
  upsertItem?(item: KnowledgeItem): void | Promise<void>;
};

export type McpContextEngineContract =
  | ContextEngine<RetrievalEngineContract>
  | AsyncContextEngine
  | {
      buildContextPack(
        ctx: AuthContext,
        opts: BuildContextPackOptions
      ): ContextPack | Promise<ContextPack>;
    };

export interface BrainRuntime {
  graph: GraphStoreContract;
  retrieval: McpRetrievalContract;
  contextEngine: McpContextEngineContract;
  handoffs: HandoffStore;
  runner: BrainRunnerQueue;
  audit: AuditLogger;
  approvals?: ApprovalQueue | PostgresApprovalQueue;
  crossServiceRegistry?: AnalyzeDistributedImpactOptions["crossServiceRegistry"];
  scheduleRunnerTask?: (input: RunnerSchedulePayload & { cron: string }) => Promise<{ scheduleId: string }>;
  opRepo?: PgOperationalRepository;
  memory?: Pick<PostgresMemoryManager, "listVisible">;
  knowledge?: Pick<KnowledgeRepository, "listVersions" | "upsertItem"> & {
    incrementHitCounts?: (ctx: AuthContext, projectId: string, itemIds: readonly string[]) => Promise<Array<{ itemId: string; hitCount: number }>>;
  };
  workspaceRoot?: string;
  workspaceRoots?: Readonly<Record<string, string>>;
  registeredProjects?: Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>;
}

export function createBrainRuntime(
  audit: AuditLogger,
  options: {
    workspaceRoot?: string;
    workspaceRoots?: Readonly<Record<string, string>>;
    scheduleRunnerTask?: (input: RunnerSchedulePayload & { cron: string }) => Promise<{ scheduleId: string }>;
  } = {}
): BrainRuntime {
  if (!audit || typeof audit.record !== "function") {
    throw new Error("createBrainRuntime requires an explicit audit logger.");
  }
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);
  const contextEngine = new ContextEngine(retrieval);
  const handoffs = new HandoffStore();
  const runner = new BrainRunnerQueue();
  const approvals = new ApprovalQueue();
  const crossServiceRegistry = new CrossServiceContractRegistry();
  const registeredProjects = new Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>();
  return {
    graph, retrieval, contextEngine, handoffs, runner, audit, approvals, crossServiceRegistry, registeredProjects,
    workspaceRoot: options.workspaceRoot ?? process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd(),
    workspaceRoots: options.workspaceRoots ?? configuredProjectWorkspaceRoots(),
    scheduleRunnerTask: options.scheduleRunnerTask
  };
}

export interface CreateSqlBrainRuntimeOptions {
  opRepo?: PgOperationalRepository;
  databaseUrl?: string;
  workspaceRoot?: string;
  workspaceRoots?: Readonly<Record<string, string>>;
  scheduleRunnerTask?: (input: RunnerSchedulePayload & { cron: string }) => Promise<{ scheduleId: string }>;
}

export function createSqlBrainRuntime(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appClient: AppPostgresClient<any>,
  rlsContext: RlsSessionContext,
  audit?: AuditLogger,
  options?: CreateSqlBrainRuntimeOptions
): BrainRuntime {
  const targetClient = appClient as unknown as AppPostgresClient<never>;
  const resolvedAudit = audit ?? createPostgresAuditLogger(targetClient, rlsContext);
  if (!resolvedAudit || typeof resolvedAudit.record !== "function") {
    throw new Error("createSqlBrainRuntime requires a valid audit logger.");
  }
  const graph = new PostgresGraphStore(targetClient, rlsContext);
  const valkeyUrl = process.env.VALKEY_URL ?? process.env.REDIS_URL;
  const retrieval = new PostgresRetrievalEngine(targetClient, graph, {
    cache: valkeyUrl ? new ValkeyRetrievalCache(valkeyUrl) : undefined
  });
  const contextEngine = new ContextEngine(retrieval);
  const handoffs = new HandoffStore();
  const runner = new BrainRunnerQueue();
  const approvals = new PostgresApprovalQueue(targetClient);
  const crossServiceRegistry = new PostgresCrossServiceRegistry(targetClient, rlsContext);
  const knowledge = new PostgresKnowledgeRepository(targetClient);
  const memory = new PostgresMemoryManager(targetClient);
  const dbUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  const opRepo = options?.opRepo ?? (dbUrl ? new PgOperationalRepository(createDatabaseClient(dbUrl).db) : undefined);
  const scheduleDatabaseUrl = process.env.DATABASE_SYSTEM_URL ?? dbUrl;
  const scheduleRunnerTask = options?.scheduleRunnerTask ?? (scheduleDatabaseUrl
    ? async (input: RunnerSchedulePayload & { cron: string }) => ({
        scheduleId: await createRunnerSchedule(input, input.cron, scheduleDatabaseUrl)
      })
    : undefined);
  return {
    graph, retrieval, contextEngine, handoffs, runner, audit: resolvedAudit, approvals, crossServiceRegistry, opRepo, memory,
    knowledge,
    workspaceRoot: options?.workspaceRoot ?? process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd(),
    workspaceRoots: options?.workspaceRoots ?? configuredProjectWorkspaceRoots(),
    scheduleRunnerTask
  };
}

function configuredProjectWorkspaceRoots(): Readonly<Record<string, string>> {
  const raw = process.env.BRAIN_PROJECT_WORKSPACE_ROOTS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS must be a JSON object mapping project IDs to workspace paths.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS must be a JSON object mapping project IDs to workspace paths.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([projectId, root]) => !projectId.trim() || typeof root !== "string" || !root.trim() || !isAbsolute(root))) {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS values must be absolute paths keyed by non-empty project IDs.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function resolveWorkspaceFile(workspaceRoot: string, inputPath: string): string {
  if (!inputPath.trim() || inputPath.includes("\0") || isAbsolute(inputPath)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "A validação aceita apenas caminhos relativos dentro do workspace autorizado.", 403);
  }
  let root: string;
  try {
    root = realpathSync(resolve(workspaceRoot));
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "O workspace configurado para validação não está disponível.", 503);
  }
  const candidate = resolve(root, inputPath);
  if (!isPathWithin(root, candidate)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    let ancestor = dirname(candidate);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    const realAncestor = realpathSync(ancestor);
    if (!isPathWithin(root, realAncestor)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
    }
    return candidate;
  }
  if (!isPathWithin(root, realCandidate)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
  }
  if (!statSync(realCandidate).isFile()) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "A validação aceita apenas arquivos dentro do workspace autorizado.", 403);
  }
  return realCandidate;
}

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function materializeKnowledgeItemVersion(current: KnowledgeItem, version: KnowledgeItemVersion): KnowledgeItem {
  const { itemId, ...versionFields } = version;
  return {
    ...current,
    ...versionFields,
    id: itemId,
    version: version.version,
    createdAt: version.createdAt,
    updatedAt: version.createdAt
  };
}

export function createBrainMcpServer(
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName = "service"
): McpServer {
  if (!auditPolicyId?.trim() || /[* ,\0\r\n]/.test(auditPolicyId)) {
    throw new Error("auditPolicyId must be an explicit policy identifier");
  }
  assertPolicyAccess(ctx, auditPolicyId);
  const connection = MCP_CONNECTION_PROFILES[profile];
  const server = new McpServer(
    { name: connection.serverName, version: "0.1.0" },
    { instructions: connection.instructions }
  );

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
      const mapped = hits.map((h) => ({ id: h.item.id, title: h.item.title, score: h.score, sourceUri: h.item.sourceUri }));
      return okJson(paginateCursor(mapped, limit ?? 20, cursor));
    }
  );

  server.tool(
    "brain_knowledge_get",
    describeMcpTool(profile, "Obtém um KnowledgeItem específico por ID e suas relações seguras no grafo."),
    {
      projectId: z.string(),
      id: z.string(),
      version: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
      depth: z.number().optional()
      ,sessionId: z.string().min(1).max(128).optional()
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
          : /^\\d+$/.test(version)
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
    "brain_analyze_change_impact",
    describeMcpTool(profile, "Calcula impactos confirmados vs. hipóteses antes de alterar código ou regras."),
    { projectId: z.string(), targetIds: z.array(z.string()).min(1), limit: z.number().optional() },
    async ({ projectId, targetIds, limit }) => {
      assertProjectAccess(ctx, projectId);
      const ruleHits = await runtime.retrieval.search(ctx, { projectId, query: "business_rule", domains: [2], limit: 100 });
      const report = await analyzeDistributedImpact(ctx, runtime.graph, projectId, targetIds, 2, {
        rules: ruleHits.map((hit) => hit.item),
        ...(runtime.crossServiceRegistry ? { crossServiceRegistry: runtime.crossServiceRegistry } : {})
      });
      const bounded = (items: typeof report.confirmedImpacts) => limit ? items.slice(0, limit) : items;
      return okJson({
        ...report,
        confirmedImpacts: bounded(report.confirmedImpacts),
        hypotheses: bounded(report.hypotheses),
        directImpacts: bounded(report.directImpacts),
        transitiveImpacts: bounded(report.transitiveImpacts)
      });
    }
  );

  server.tool(
    "brain_validate_implementation",
    describeMcpTool(profile, "Valida um conjunto de arquivos/diff contra regras e decisões conhecidas."),
    {
      projectId: z.string(),
      paths: z.array(z.string()).optional(),
      diffOrPaths: z.array(z.string()).optional(),
      mode: z.enum(["audit", "advisory", "enforced"]).optional(),
      limit: z.number().optional()
    },
    async ({ projectId, paths, diffOrPaths, mode, limit }) => {
      assertProjectAccess(ctx, projectId);
      const effectiveMode = mode ?? "advisory";
      const targetPaths = diffOrPaths ?? paths ?? [];
      if (targetPaths.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe ao menos um caminho em diffOrPaths ou paths.", 400);
      }
      const workspaceRoot = runtime.workspaceRoots?.[projectId]
        ?? configuredProjectWorkspaceRoots()[projectId]
        ?? runtime.workspaceRoot
        ?? process.env.BRAIN_WORKSPACE_ROOT
        ?? process.cwd();
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", domains: [2, 3], limit: 100 });
      const activeRules = hits.map((h) => h.item);
      const files = targetPaths.map((path) => {
        const safePath = resolveWorkspaceFile(workspaceRoot, path);
        return { path, content: existsSync(safePath) ? readFileSync(safePath, "utf8") : "" };
      });
      const imports: ArchitectureImportEdge[] = [];
      for (const file of files) {
        if (!file.content) continue;
        const deps = extractFileDependencies(file.path, file.content);
        const pkgMatch = file.path.replace(/\\/g, "/").match(/(?:^|\/)(packages|apps)\/([^/]+)\//);
        const fromPkg = pkgMatch ? (pkgMatch[1] === "apps" ? `apps/${pkgMatch[2]}` : pkgMatch[2]!) : "apps/unknown";
        for (const dep of deps) {
          if (dep.startsWith("@brain/")) {
            imports.push({ fromPkg, toPkg: dep, filePath: file.path });
          }
        }
      }
      const brReport = evaluateBusinessRuleCompliance({
        mode: effectiveMode,
        files,
        activeRules
      });
      const archReport = evaluateArchitectureChange({
        mode: effectiveMode,
        imports
      });
      const allViolations = [...archReport.violations, ...brReport.violations];
      const violations = limit ? allViolations.slice(0, limit) : allViolations;
      return okJson({
        projectId,
        mode: effectiveMode,
        passed: archReport.passed && brReport.passed,
        checkedPaths: targetPaths,
        checkedRules: brReport.checkedRules,
        checkedImports: imports.length,
        violations
      });
    }
  );

  server.tool(
    "brain_create_handoff",
    describeMcpTool(profile, "Salva checkpoint validado (branch, commit, arquivos, testes, próximos passos) para outra IDE."),
    {
      projectId: z.string(),
      taskId: z.string(),
      plan: z.string().optional(),
      fromAgent: z.string().optional(),
      repoUrl: z.string().optional(),
      branch: z.string().optional(),
      baseCommitSha: z.string().optional(),
      modifiedFiles: z.array(z.string()).optional(),
      nextSteps: z.array(z.string()),
      workingTreeDirty: z.boolean().optional(),
      testsExecuted: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional()
    },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      const decisions = input.decisions ?? (input.plan ? [input.plan] : []);
      const ho = runtime.handoffs.createHandoff(ctx, {
        projectId: input.projectId,
        taskId: input.taskId,
        fromAgent: input.fromAgent ?? ctx.actorId,
        repoUrl: input.repoUrl ?? ".",
        branch: input.branch ?? "main",
        baseCommitSha: input.baseCommitSha ?? "HEAD",
        modifiedFiles: input.modifiedFiles ?? [],
        nextSteps: input.nextSteps,
        workingTreeDirty: input.workingTreeDirty ?? false,
        testsExecuted: input.testsExecuted ?? [],
        decisions
      });
      if (runtime.opRepo) {
        await runtime.opRepo.saveHandoff(ctx, ho);
        await runtime.opRepo.upsertLease(ctx, ho.projectId, ho.taskId, ho.branch);
      }
      return okJson(ho);
    }
  );

  server.tool(
    "brain_resume_handoff",
    describeMcpTool(profile, "Retoma tarefa iniciada em outra IDE verificando divergências de branch/commit e leases."),
    { projectId: z.string(), handoffId: z.string().optional(), taskId: z.string().optional(), currentBranch: z.string().optional(), currentCommitSha: z.string().optional() },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      if (Boolean(input.handoffId) === Boolean(input.taskId)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe exatamente um entre handoffId e taskId.", 400);
      }
      const mem = runtime.handoffs.resumeHandoff(ctx, input);
      if (!mem.handoff && runtime.opRepo) {
        const persisted = input.handoffId
          ? await runtime.opRepo.getHandoffById?.(ctx, input.projectId, input.handoffId)
          : await runtime.opRepo.getLatestHandoff(ctx, input.projectId, input.taskId);
        if (persisted) {
          const warnings: string[] = [];
          if (input.currentBranch && input.currentBranch !== persisted.branch) {
            warnings.push(`Divergência de branch: esperado '${persisted.branch}', atual '${input.currentBranch}'.`);
          }
          if (input.currentCommitSha && input.currentCommitSha !== persisted.baseCommitSha) {
            warnings.push(`Divergência de commit: esperado '${persisted.baseCommitSha}', atual '${input.currentCommitSha}'.`);
          }
          if (persisted.workingTreeDirty) {
            warnings.push("Handoff anterior foi salvo com working tree dirty.");
          }
          const lease = await runtime.opRepo.getTaskLease?.(ctx, input.projectId, persisted.taskId);
          if (lease && (lease.actorId !== ctx.actorId || (input.currentBranch && lease.branch !== input.currentBranch))) {
            warnings.push(`Task Lease ativo por '${lease.actorId}' na branch '${lease.branch}'.`);
          }
          return okJson({ handoff: persisted, warnings });
        }
      }
      const warnings = [...mem.warnings];
      if (input.currentCommitSha && mem.handoff && input.currentCommitSha !== mem.handoff.baseCommitSha) {
        warnings.push(`Divergência de commit: esperado '${mem.handoff.baseCommitSha}', atual '${input.currentCommitSha}'.`);
      }
      return okJson({ ...mem, warnings });
    }
  );

  server.tool(
    "brain_record_learning",
    describeMcpTool(profile, "Registra memória episódica e feedback de utilidade (Context Hit Rate)."),
    {
      projectId: z.string(),
      summary: z.string(),
      usedItemIds: z.array(z.string()).optional(),
      sessionId: z.string().min(1).max(128).optional(),
      taskId: z.string().optional(),
      editedPaths: z.array(z.string()).optional(),
      missingPaths: z.array(z.string()).optional()
    },
    async ({ projectId, summary, usedItemIds, sessionId, taskId, editedPaths, missingPaths }) => {
      assertProjectAccess(ctx, projectId);
      const uniqueUsedItemIds = [...new Set(usedItemIds ?? [])];
      let hitRateUpdated = 0;
      let hitRate = null;
      const evidenceWarnings: string[] = [];
      if ((uniqueUsedItemIds.length > 0 || (editedPaths?.length ?? 0) > 0 || Boolean(taskId)) && (!sessionId || !runtime.opRepo)) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId e persistência de sessão são necessários para registrar evidência.", 400);
      if (uniqueUsedItemIds.length > 0 && sessionId && runtime.opRepo) {
        const result = await runtime.opRepo.recordContextEvidence(ctx, projectId, sessionId, uniqueUsedItemIds, "citation");
        hitRateUpdated = result.newlyHit.length;
        hitRate = result.rate;
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      } else if (runtime.knowledge?.incrementHitCounts) {
        for (const id of uniqueUsedItemIds) {
          const item = await runtime.retrieval.getItem(ctx, projectId, id);
          if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${id}' não encontrado ou sem permissão.`, 404);
        }
        const updated = await runtime.knowledge.incrementHitCounts(ctx, projectId, uniqueUsedItemIds);
        hitRateUpdated = updated.length;
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      } else {
        for (const id of uniqueUsedItemIds) runtime.retrieval.recordHitBoost(projectId, id);
        hitRateUpdated = uniqueUsedItemIds.length;
      }
      if (taskId || (editedPaths?.length ?? 0) > 0) {
        if (!sessionId || !taskId || !runtime.opRepo) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId, taskId e lease ativo são necessários para evidência de edição.", 400);
        const lease = await runtime.opRepo.getTaskLease(ctx, projectId, taskId);
        if (!lease || lease.actorId !== ctx.actorId) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Evidência de edição requer lease ativo do ator autenticado.", 403);
        const candidates = await runtime.opRepo.getContextEditCandidates(ctx, projectId, sessionId, taskId);
        const workspaceRoot = runtime.workspaceRoots?.[projectId] ?? runtime.workspaceRoot ?? process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd();
        const changedSources = await findChangedWorkspaceSources(workspaceRoot, candidates);
        const requested = editedPaths?.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean);
        const requestedSet = requested ? new Set(requested) : undefined;
        const confirmedPaths = requestedSet ? changedSources.filter((path) => requestedSet.has(path)) : changedSources;
        const edited = await runtime.opRepo.recordContextEdits(ctx, projectId, sessionId, taskId, confirmedPaths);
        hitRate = edited.rate;
        hitRateUpdated += edited.newlyHit.length;
        const candidatePaths = new Set(candidates.map((candidate) => candidate.sourceUri));
        if (candidates.length === 0) evidenceWarnings.push("Nenhuma fonte local com hash de baseline foi entregue nesta sessão e tarefa; evidência automática de diff indisponível.");
        else if (!requested && changedSources.length === 0) evidenceWarnings.push("Nenhuma fonte local entregue mudou desde a montagem do Context Pack.");
        for (const path of requested ?? []) {
          if (!candidatePaths.has(path)) evidenceWarnings.push(`O caminho '${path}' não tem hash de baseline para esta sessão e tarefa.`);
          else if (!changedSources.includes(path)) evidenceWarnings.push(`O caminho '${path}' não mudou desde a entrega do Context Pack.`);
        }
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      }
      if (runtime.opRepo) {
        await runtime.opRepo.appendMemory(ctx, {
          projectId,
          layer: "episodic",
          content: summary,
          accessPolicyId: auditPolicyId
        });
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId, projectId, accessPolicyId: auditPolicyId, actorId: ctx.actorId, actorType: ctx.actorType,
        action: "create", targetType: "memory", metadata: { summary, usedItemIds: uniqueUsedItemIds, missingPaths }
      });
      return okJson({ recorded: true, hitRateUpdated, hitRate, warnings: evidenceWarnings });
    }
  );

  server.tool(
    "brain_change_propose",
    describeMcpTool(profile, "Submete proposta formal em status draft para revisão humana."),
    {
      projectId: z.string(),
      title: z.string().min(1),
      content: z.string().min(1),
      targetType: z.string().optional()
    },
    async ({ projectId, title, content, targetType }) => {
      assertProjectAccess(ctx, projectId);
      const proposalId = `PROP-${randomUUID()}`;
      const typeVal = targetType ?? "business_rule";
      const filePath = `.brain/01-business/${proposalId}.md`;
      const rawContent = `---\nid: ${proposalId}\ntitle: ${title}\ntype: ${typeVal}\nstatus: draft\naccess_policy: ${auditPolicyId}\n---\n\n${content}`;
      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId,
        filePath,
        rawContent
      });
      if (runtime.knowledge?.upsertItem) {
        await runtime.knowledge.upsertItem(ctx, item);
      } else if (typeof runtime.retrieval.upsertItem === "function") {
        await runtime.retrieval.upsertItem(item);
      }
      if (runtime.approvals) {
        await runtime.approvals.submit(ctx, item);
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId, projectId, accessPolicyId: auditPolicyId, actorId: ctx.actorId, actorType: ctx.actorType,
        action: "create", targetType: "proposal", targetId: proposalId, metadata: { title, targetType: typeVal }
      });
      return okJson({ proposalId, status: "draft", projectId, title, sourceUri: filePath });
    }
  );

  server.tool(
    "brain_change_decide",
    describeMcpTool(profile, "Registra decisão autorizada sobre uma proposta (humanos autorizados ou agentes vinculados a usuário com herança de permissões)."),
    {
      projectId: z.string(),
      proposalId: z.string().min(1),
      decision: z.enum(["approve", "reject", "request_changes"]),
      note: z.string().optional()
    },
    async ({ projectId, proposalId, decision, note }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.approvals) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Fila de aprovação indisponível neste runtime MCP.", 503);
      }
      const effectiveCtx = runtime.opRepo
        ? await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId)
        : ctx;
      const decided = await runtime.approvals.decide(effectiveCtx, projectId, proposalId, decision, note);
      if (decision === "approve") {
        if (runtime.knowledge?.upsertItem) {
          await runtime.knowledge.upsertItem(ctx, decided.item);
        } else if (typeof runtime.retrieval.upsertItem === "function") {
          await runtime.retrieval.upsertItem(decided.item);
        }
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: decided.item.accessPolicyId ?? auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: decision === "approve" ? "approve" : "update",
        targetType: "proposal",
        targetId: proposalId,
        metadata: { decision, status: decided.status, ...(note ? { note } : {}) }
      });
      return okJson({
        proposalId: decided.proposalId,
        projectId: decided.projectId,
        status: decided.status,
        itemStatus: decided.item.status,
        reviewedBy: decided.reviewedBy,
        ...(decided.reviewNote ? { reviewNote: decided.reviewNote } : {})
      });
    }
  );

  server.tool(
    "brain_delegate_task",
    describeMcpTool(profile, "Enfileira uma tarefa em background para o Brain Runner ou agenda execuções recorrentes via cron UTC."),
    {
      projectId: z.string(),
      instruction: z.string().min(1),
      cron: z.string().min(1).optional(),
      priority: z.enum(["low", "normal", "high"]).optional()
    },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      if (input.cron) {
        if (!runtime.scheduleRunnerTask) {
          throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Agendamento cron requer DATABASE_URL e um scheduler pg-boss configurado.", 503);
        }
        const schedule = await runtime.scheduleRunnerTask({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          actorId: ctx.actorId,
          accessPolicyId: auditPolicyId,
          instruction: input.instruction,
          priority: input.priority ?? "normal",
          cron: input.cron
        });
        await runtime.audit.record({
          tenantId: ctx.tenantId, projectId: input.projectId, accessPolicyId: auditPolicyId,
          actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "runner_schedule",
          targetId: schedule.scheduleId, metadata: { cron: input.cron, priority: input.priority ?? "normal" }
        });
        return okJson({ ...schedule, status: "scheduled", cron: input.cron });
      }
      const task = runtime.runner.enqueue(ctx, input);
      if (runtime.opRepo) {
        await runtime.opRepo.saveRunnerTask(ctx, task);
      }
      return okJson({ ...task, ...(input.cron ? { cron: input.cron } : {}) });
    }
  );

  registerExtendedMcpTools(server, runtime, ctx, auditPolicyId, profile);

  return server;
}

if (process.argv[1]?.endsWith("index.js")) {
  const configuredList = (value: string | undefined) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const localCtx: AuthContext = {
    tenantId: process.env.BRAIN_TENANT_ID ?? "default-org",
    actorId: process.env.BRAIN_ACTOR_ID ?? "local-agent",
    actorType: "agent",
    roles: ["developer"],
    allowedProjects: configuredList(process.env.BRAIN_ALLOWED_PROJECTS),
    allowedPolicies: configuredList(process.env.BRAIN_ALLOWED_POLICIES)
  };
  const auditPolicyId = process.env.BRAIN_AUDIT_POLICY_ID;
  if (!auditPolicyId) throw new Error("BRAIN_AUDIT_POLICY_ID is required");
  assertPolicyAccess(localCtx, auditPolicyId);
  const rlsContext: RlsSessionContext = {
    tenantId: localCtx.tenantId,
    allowedProjects: localCtx.allowedProjects,
    allowedPolicies: localCtx.allowedPolicies
  };
  const appPostgresClient = createAppPostgresClient();
  const runtime = createSqlBrainRuntime(appPostgresClient, rlsContext);
  const server = createBrainMcpServer(runtime, localCtx, auditPolicyId, "local");
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    appPostgresClient.close().catch(() => {});
    console.error(err);
    process.exit(1);
  });
}

