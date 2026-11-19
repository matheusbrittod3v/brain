import { HandoffStore } from "@brain/agent-handoff";
import { BrainRunnerQueue } from "@brain/agent-runner";
import { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import {
  createPostgresAuditLogger,
  type AppPostgresClient,
  type AuditLogger,
  type RlsSessionContext
} from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import {
  ContextEngine,
  type AsyncContextEngine,
  type BuildContextPackOptions,
  type ContextPack,
  type RetrievalEngineContract
} from "@brain/context-engine";
import type { KnowledgeItem } from "@brain/core";
import { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import { createDatabaseClient, PgOperationalRepository, PgSystemSettingsRepository } from "@brain/database";
import { KnowledgeGraphStore, PostgresGraphStore, type GraphStoreContract } from "@brain/graph";
import type { AnalyzeDistributedImpactOptions } from "@brain/impact-analysis";
import { PostgresKnowledgeRepository, type KnowledgeRepository } from "@brain/knowledge";
import { PostgresMemoryManager } from "@brain/memory";
import {
  HybridRetrievalEngine,
  PostgresRetrievalEngine,
  ValkeyRetrievalCache,
  type SearchHit,
  type SearchQuery
} from "@brain/retrieval";
import { configuredProjectWorkspaceRoots } from "./helpers.js";
import { createRunnerSchedule, type RunnerSchedulePayload } from "./runner-schedules.js";

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
  enqueueEmbedding?: (item: KnowledgeItem) => Promise<string | null>;
  opRepo?: PgOperationalRepository;
  systemSettings?: PgSystemSettingsRepository;
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
  enqueueEmbedding?: (item: KnowledgeItem) => Promise<string | null>;
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
  systemSettings?: PgSystemSettingsRepository;
  databaseUrl?: string;
  workspaceRoot?: string;
  workspaceRoots?: Readonly<Record<string, string>>;
  scheduleRunnerTask?: (input: RunnerSchedulePayload & { cron: string }) => Promise<{ scheduleId: string }>;
  enqueueEmbedding?: (item: KnowledgeItem) => Promise<string | null>;
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

