import type { AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";
import type {
  CrossServiceContractEdge,
  DistributedBlastRadius
} from "@noema/cross-service";
import type { GraphStoreContract, TraversalHit } from "@noema/graph";

export type BusinessRuleCriticality = "low" | "medium" | "high" | "critical";
export type ImpactRiskLevel = "low" | "medium" | "high" | "critical";

export interface ImpactRuleRef {
  id: string;
  title?: string;
  priority: BusinessRuleCriticality;
  status?: KnowledgeItem["status"];
  relatedIds?: readonly string[];
}

export interface AnalyzeDistributedImpactOptions {
  maxDepth?: number;
  crossServiceRegistry?: {
    buildFederatedContextPack(ctx: AuthContext, projectIds: string[]): { projects: string[]; contracts: CrossServiceContractEdge[] } | Promise<{ projects: string[]; contracts: CrossServiceContractEdge[] }>;
    computeDistributedBlastRadius(ctx: AuthContext, contractId: string): DistributedBlastRadius | Promise<DistributedBlastRadius>;
  };
  contractIds?: readonly string[];
  rules?: readonly (KnowledgeItem | ImpactRuleRef)[];
}

export interface ChangeImpactReport {
  projectId: string;
  confirmedImpacts: TraversalHit[];
  hypotheses: TraversalHit[];
  directImpacts: TraversalHit[];
  transitiveImpacts: TraversalHit[];
  crossServiceImpacts: DistributedBlastRadius[];
  criticalRulesImpacted: ImpactRuleRef[];
  riskLevel: ImpactRiskLevel;
}

function isKnowledgeItem(item: KnowledgeItem | ImpactRuleRef): item is KnowledgeItem {
  return "content" in item && "type" in item;
}

function normalizeRuleRef(rule: KnowledgeItem | ImpactRuleRef): ImpactRuleRef {
  if (isKnowledgeItem(rule)) {
    const rawPriority = String(rule.metadata?.priority ?? "medium");
    const priority = (["low", "medium", "high", "critical"].includes(rawPriority)
      ? rawPriority
      : "medium") as BusinessRuleCriticality;
    return {
      id: rule.id,
      title: rule.title,
      priority,
      status: rule.status,
      relatedIds: rule.relatedIds
    };
  }
  return rule;
}

function deduplicateHits(hits: readonly TraversalHit[]): TraversalHit[] {
  const byKey = new Map<string, TraversalHit>();
  for (const hit of hits) {
    const key = `${hit.projectId}::${hit.itemId}::${hit.via}`;
    const existing = byKey.get(key);
    if (!existing || hit.hops < existing.hops || (existing.isInferred && !hit.isInferred)) {
      byKey.set(key, hit);
    }
  }
  return [...byKey.values()];
}

async function resolveCrossServiceImpacts(
  ctx: AuthContext,
  projectId: string,
  targetIds: readonly string[],
  hits: readonly TraversalHit[],
  registry: NonNullable<AnalyzeDistributedImpactOptions["crossServiceRegistry"]>,
  explicitContractIds?: readonly string[]
): Promise<DistributedBlastRadius[]> {
  const candidateIds = new Set<string>(explicitContractIds ?? []);
  const touchedTokens = new Set<string>([
    ...targetIds,
    ...hits.map((h) => h.itemId)
  ]);

  const federated = await registry.buildFederatedContextPack(ctx, [projectId]);
  for (const edge of federated.contracts) {
    if (touchedTokens.has(edge.contractId) || touchedTokens.has(edge.fromService)) {
      candidateIds.add(edge.contractId);
    }
  }

  const results: DistributedBlastRadius[] = [];
  for (const contractId of [...candidateIds].sort()) {
    const blast = await registry.computeDistributedBlastRadius(ctx, contractId);
    if (blast.impactedProjects.length > 0 || blast.impactedServices.length > 0) {
      results.push(blast);
    }
  }
  return results;
}

function resolveCriticalImpactedRules(
  targetIds: readonly string[],
  hits: readonly TraversalHit[],
  rules: readonly (KnowledgeItem | ImpactRuleRef)[]
): ImpactRuleRef[] {
  const touchedIds = new Set<string>([
    ...targetIds,
    ...hits.map((h) => h.itemId)
  ]);

  const impacted: ImpactRuleRef[] = [];
  for (const rawRule of rules) {
    if (isKnowledgeItem(rawRule) && rawRule.type !== "business_rule") {
      continue;
    }
    const rule = normalizeRuleRef(rawRule);
    if (rule.status && rule.status !== "approved") {
      continue;
    }
    if (rule.priority !== "high" && rule.priority !== "critical") {
      continue;
    }
    const isTouched =
      touchedIds.has(rule.id) ||
      (rule.relatedIds?.some((relId) => touchedIds.has(relId)) ?? false);
    if (isTouched) {
      impacted.push(rule);
    }
  }
  return impacted;
}

function computeRiskLevel(
  confirmedImpacts: readonly TraversalHit[],
  transitiveImpacts: readonly TraversalHit[],
  crossServiceImpacts: readonly DistributedBlastRadius[],
  criticalRulesImpacted: readonly ImpactRuleRef[]
): ImpactRiskLevel {
  const hasCriticalRule = criticalRulesImpacted.some((r) => r.priority === "critical");
  const hasHighRule = criticalRulesImpacted.some((r) => r.priority === "high");
  const impactedProjectCount = new Set(
    crossServiceImpacts.flatMap((c) => c.impactedProjects)
  ).size;
  const impactedServiceCount = crossServiceImpacts.reduce(
    (sum, c) => sum + c.impactedServices.length,
    0
  );

  if (
    hasCriticalRule ||
    (hasHighRule && impactedProjectCount >= 2) ||
    impactedServiceCount >= 3
  ) {
    return "critical";
  }

  if (
    confirmedImpacts.length >= 5 ||
    hasHighRule ||
    (crossServiceImpacts.length > 0 && impactedProjectCount >= 2)
  ) {
    return "high";
  }

  if (
    confirmedImpacts.length >= 2 ||
    crossServiceImpacts.length > 0 ||
    transitiveImpacts.length >= 3
  ) {
    return "medium";
  }

  return "low";
}

export async function analyzeDistributedImpact(
  ctx: AuthContext,
  graph: GraphStoreContract,
  projectId: string,
  targetIds: readonly string[],
  maxDepthOrOptions: number | AnalyzeDistributedImpactOptions = 2,
  maybeOptions?: AnalyzeDistributedImpactOptions
): Promise<ChangeImpactReport> {
  const options: AnalyzeDistributedImpactOptions =
    typeof maxDepthOrOptions === "number"
      ? { ...(maybeOptions ?? {}), maxDepth: maxDepthOrOptions }
      : maxDepthOrOptions;

  const maxDepth = options.maxDepth ?? 2;

  const results = await Promise.all(
    targetIds.map((itemId) =>
      Promise.resolve(graph.traverseRelated(ctx, { projectId, itemId }, maxDepth))
    )
  );
  const all = deduplicateHits(results.flat());
  const confirmedImpacts = all.filter((h) => !h.isInferred);
  const hypotheses = all.filter((h) => h.isInferred);
  const directImpacts = all.filter((h) => h.hops <= 1);
  const transitiveImpacts = all.filter((h) => h.hops > 1);

  const crossServiceImpacts = options.crossServiceRegistry
    ? await resolveCrossServiceImpacts(
        ctx,
        projectId,
        targetIds,
        all,
        options.crossServiceRegistry,
        options.contractIds
      )
    : [];

  const criticalRulesImpacted = options.rules
    ? resolveCriticalImpactedRules(targetIds, all, options.rules)
    : [];

  const riskLevel = computeRiskLevel(
    confirmedImpacts,
    transitiveImpacts,
    crossServiceImpacts,
    criticalRulesImpacted
  );

  return {
    projectId,
    confirmedImpacts,
    hypotheses,
    directImpacts,
    transitiveImpacts,
    crossServiceImpacts,
    criticalRulesImpacted,
    riskLevel
  };
}
