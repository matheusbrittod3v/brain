import type { AppPostgresClient } from "@noema/audit-engine";
import type { AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import { computeProjectHealthReport } from "@noema/enterprise-views";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import type { PostgresKnowledgeRepository } from "@noema/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { configuredGitHubRepositories } from "./jobs.js";

export function createProjectMetricsService(deps: {
  appPostgresClient?: AppPostgresClient;
  opRepo?: PgOperationalRepository;
  pgGraph?: PostgresGraphStore;
  graph: KnowledgeGraphStore;
  pgKnowledge?: PostgresKnowledgeRepository;
  pgRetrieval?: PostgresRetrievalEngine;
  retrieval: HybridRetrievalEngine;
  githubMainHeadMemory: Map<string, { repository: string; commitSha: string; accessPolicyId: string }>;
  testExecutionMemory: Map<string, {
    testItemId: string;
    accessPolicyId: string;
    commitSha: string;
    repository?: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number | null;
    executedAt: string;
    receivedBy: string;
  }>;
}) {
  const {
    appPostgresClient,
    opRepo,
    pgGraph,
    graph,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    githubMainHeadMemory,
    testExecutionMemory
  } = deps;

  async function projectVerifiedTests(
    ctx: AuthContext,
    projectId: string,
    items: KnowledgeItem[]
  ) {
    const githubRepositories = configuredGitHubRepositories(ctx.tenantId, projectId);
    const requiresMainHead = githubRepositories.length > 0;
    const mainHeads = pgRetrieval && opRepo
      ? await opRepo.listGitHubMainHeads(ctx, projectId)
      : [...githubMainHeadMemory.entries()]
        .filter(([key]) => key.startsWith(`${ctx.tenantId}:${projectId}:`))
        .map(([, head]) => head);
    const mainHeadByRepository = new Map(mainHeads.map((head) => [head.repository.toLowerCase(), head.commitSha.toLowerCase()]));
    const linkedTestsByRule = new Map<string, string[]>();
    const testItemsById = new Map(items.filter((item) => item.type === "test").map((item) => [item.id, item]));
    for (const rule of items.filter((item) => item.type === "business_rule" && item.status !== "deprecated")) {
      // Include Rule -> CodeSymbol -> Test so explicit symbol mappings count alongside direct @brain-rule anchors.
      const related = await (pgGraph ?? graph).traverseRelated(ctx, { projectId, itemId: rule.id }, 2);
      const testIds = related.filter((hit) => hit.via === "VERIFIED_BY").map((hit) => hit.itemId);
      for (const testId of testIds) {
        if (testItemsById.has(testId)) continue;
        const test = pgKnowledge
          ? await pgKnowledge.getItem(ctx, projectId, testId)
          : retrieval.getItem(ctx, projectId, testId);
        if (test && (test.type === "test" || /\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(test.sourceUri))) testItemsById.set(testId, test);
      }
      const existingTestIds = [...new Set(testIds)].filter((testId) => testItemsById.has(testId));
      if (existingTestIds.length > 0) linkedTestsByRule.set(rule.id, existingTestIds);
    }
    const linkedTestIds = [...new Set([...linkedTestsByRule.values()].flat())];
    const testExecutionResults = pgRetrieval && opRepo
      ? requiresMainHead
        ? mainHeadByRepository.size > 0
          ? await opRepo.listLatestTestExecutionResults(ctx, projectId, linkedTestIds, mainHeadByRepository)
          : []
        : await opRepo.listLatestTestExecutionResults(ctx, projectId, linkedTestIds)
      : [...testExecutionMemory.entries()]
        .filter(([key]) => key.startsWith(`${ctx.tenantId}:${projectId}:`))
        .map(([, value]) => value)
        .filter((result) => !requiresMainHead || Boolean(result.repository && mainHeadByRepository.get(result.repository.toLowerCase()) === result.commitSha.toLowerCase()))
        .sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    const latestByTest = new Map<string, (typeof testExecutionResults)[number]>();
    for (const result of testExecutionResults) if (!latestByTest.has(result.testItemId)) latestByTest.set(result.testItemId, result);
    const latestTestExecutionResults = [...latestByTest.values()];
    const verifiedTests = new Map<string, string[]>();
    for (const [ruleId, testIds] of linkedTestsByRule) {
      const passing = testIds.filter((testId) => {
        const test = testItemsById.get(testId)!;
        const result = latestByTest.get(testId);
        if (result?.status !== "passed") return false;
        const sourceRepository = typeof test.metadata?.sourceRepository === "string" ? test.metadata.sourceRepository.toLowerCase() : undefined;
        if (githubRepositories.length > 1 && !sourceRepository) return false;
        if (sourceRepository && sourceRepository !== result.repository?.toLowerCase()) return false;
        return !/^[a-f0-9]{40,64}$/i.test(test.sourceVersion) || test.sourceVersion.toLowerCase() === result.commitSha.toLowerCase();
      });
      if (passing.length > 0) verifiedTests.set(ruleId, passing);
    }
    return {
      verifiedTests,
      linkedTestsByRule,
      testItemsById,
      testExecutionResults: latestTestExecutionResults,
      requireMainHead: requiresMainHead,
      requireRepositoryAssociation: githubRepositories.length > 1,
      mainHeadByRepository
    };
  }

  function projectHealth(items: KnowledgeItem[], verifiedTests: Map<string, string[]>) {
    const health = computeProjectHealthReport(items, []);
    health.untestedRuleIds = health.untestedRuleIds.filter((id) => !verifiedTests.has(id));
    const penalty = health.untestedRuleIds.length * 10 + health.staleItemIds.length * 5 + health.gitVsConnectorConflicts.length * 15;
    health.healthScore = Math.max(0, 100 - penalty);
    return health;
  }

  async function projectModelUsage(ctx: AuthContext, projectId: string) {
    if (!appPostgresClient || !process.env.DATABASE_URL) {
      return { windowDays: 30, modelUsageAvailable: false, calls: 0, byModel: [], providerCostUsd: null, infrastructureCostAvailable: false };
    }
    const rows = await appPostgresClient.withRlsTransaction(
      { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
      async (client) => await client`
        SELECT result_metadata->'modelUsage' AS model_usage
        FROM runner_tasks
        WHERE tenant_id = ${ctx.tenantId}
          AND project_id = ${projectId}
          AND created_at >= now() - interval '30 days'
          AND result_metadata->'modelUsage' IS NOT NULL
      ` as Array<{ model_usage: unknown }>
    );
    const groups = new Map<string, {
      provider: string; model: string; costBasis: string; calls: number;
      inputTokens: number; outputTokens: number; totalTokens: number;
      tokenCalls: number; providerCostUsd: number; knownCostCalls: number;
    }>();
    for (const row of rows) {
      const usage = typeof row.model_usage === "string" ? JSON.parse(row.model_usage) as Record<string, unknown> : row.model_usage as Record<string, unknown>;
      if (!usage || typeof usage !== "object") continue;
      const provider = typeof usage.provider === "string" ? usage.provider : "unknown";
      const model = typeof usage.model === "string" ? usage.model : "unknown";
      const costBasis = typeof usage.costBasis === "string" ? usage.costBasis : "unknown";
      const key = `${provider}:${model}:${costBasis}`;
      const group = groups.get(key) ?? { provider, model, costBasis, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenCalls: 0, providerCostUsd: 0, knownCostCalls: 0 };
      group.calls += 1;
      const input = typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
      const output = typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
      const total = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
      if (input !== null && output !== null && total !== null) {
        group.inputTokens += input; group.outputTokens += output; group.totalTokens += total; group.tokenCalls += 1;
      }
      if (typeof usage.providerCostUsd === "number" && Number.isFinite(usage.providerCostUsd)) {
        group.providerCostUsd += usage.providerCostUsd; group.knownCostCalls += 1;
      }
      groups.set(key, group);
    }
    const byModel = [...groups.values()].map((group) => ({
      provider: group.provider, model: group.model, costBasis: group.costBasis, calls: group.calls,
      inputTokens: group.tokenCalls === group.calls ? group.inputTokens : null,
      outputTokens: group.tokenCalls === group.calls ? group.outputTokens : null,
      totalTokens: group.tokenCalls === group.calls ? group.totalTokens : null,
      providerCostUsd: group.knownCostCalls === group.calls ? group.providerCostUsd : null
    }));
    const allCostsKnown = byModel.every((group) => group.providerCostUsd !== null);
    return {
      windowDays: 30,
      modelUsageAvailable: rows.length > 0,
      calls: rows.length,
      byModel,
      providerCostUsd: allCostsKnown && rows.length > 0 ? byModel.reduce((sum, group) => sum + (group.providerCostUsd ?? 0), 0) : null,
      infrastructureCostAvailable: false
    };
  }

  return { projectVerifiedTests, projectHealth, projectModelUsage };
}

