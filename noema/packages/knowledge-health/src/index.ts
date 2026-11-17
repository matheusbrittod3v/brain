import type { KnowledgeItem } from "@noema/core";
import type { GraphEdge } from "@noema/graph";

export interface ContradictoryKnowledgePair {
  itemAId: string;
  itemBId: string;
  reason: string;
}

export interface PrecedenceConflict {
  id: string;
  winningSourceKind: KnowledgeItem["sourceKind"];
  sources: Array<{
    sourceKind: KnowledgeItem["sourceKind"];
    sourceOrigin: KnowledgeItem["sourceOrigin"];
    contentHash: string;
  }>;
}

export interface ProjectHealthReport {
  healthScore: number;
  untestedRuleIds: string[];
  uncoveredCriticalRuleIds: string[];
  contradictoryItems: ContradictoryKnowledgePair[];
  missingSourceUriIds: string[];
  missingAcceptanceCriteriaIds: string[];
  staleItemIds: string[];
  gitVsConnectorConflicts: Array<{ id: string; gitHash: string; connectorHash: string }>;
  precedenceConflicts: PrecedenceConflict[];
}

const SOURCE_PRECEDENCE: Record<KnowledgeItem["sourceKind"], number> = {
  git: 4,
  api: 3,
  connector: 2,
  agent: 1
};

function isHighOrCritical(item: KnowledgeItem): boolean {
  const severity = String(item.metadata?.severity ?? "").toLowerCase();
  const priority = String(item.metadata?.priority ?? "").toLowerCase();
  if (severity === "high" || severity === "critical") return true;
  if (priority === "high" || priority === "critical") return true;
  return item.tags.some((t) => {
    const lower = t.toLowerCase();
    return lower === "critical" || lower === "high";
  });
}

function hasAcceptanceCriteria(item: KnowledgeItem): boolean {
  const ac = item.metadata?.acceptanceCriteria;
  if (Array.isArray(ac)) return ac.some((entry) => String(entry).trim().length > 0);
  if (typeof ac === "string") return ac.trim().length > 0;
  return false;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function shareAnyTag(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a.map((t) => t.toLowerCase()));
  return b.some((t) => setA.has(t.toLowerCase()));
}

function detectContradictions(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[]
): ContradictoryKnowledgePair[] {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const pairs: ContradictoryKnowledgePair[] = [];
  const seenPairs = new Set<string>();

  const addPair = (aId: string, bId: string, reason: string) => {
    const key = [aId, bId].sort().join("::") + "::" + reason;
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      pairs.push({ itemAId: aId, itemBId: bId, reason });
    }
  };

  // 1. Conflitos via arestas SUPERSEDES ou BLOCKED_BY com ambos ainda ativos/aprovados
  for (const edge of edges) {
    const from = itemById.get(edge.fromItemId);
    const to = itemById.get(edge.toItemId);
    if (!from || !to) continue;

    if (edge.relationType === "SUPERSEDES" && from.status === "approved" && to.status === "approved") {
      addPair(from.id, to.id, "Aresta SUPERSEDES entre dois itens com status 'approved'.");
    }
    if (edge.relationType === "BLOCKED_BY" && from.status === "approved" && to.status === "approved") {
      addPair(from.id, to.id, "Aresta BLOCKED_BY ativa entre dois itens 'approved'.");
    }
  }

  // 2. Conflitos via metadata.supersedes / metadata.contradicts ou mesmo domínio/tags/título
  const governedItems = items.filter((i) => i.type === "business_rule" || i.type === "architecture_decision");
  for (let i = 0; i < governedItems.length; i++) {
    const a = governedItems[i]!;
    const metaSupersedes = typeof a.metadata?.supersedes === "string" ? a.metadata.supersedes : undefined;
    if (metaSupersedes) {
      const target = itemById.get(metaSupersedes);
      if (target && a.status === "approved" && target.status === "approved") {
        addPair(a.id, target.id, "metadata.supersedes aponta para item ainda 'approved'.");
      }
    }

    const metaContradicts = typeof a.metadata?.contradicts === "string" ? a.metadata.contradicts : undefined;
    if (metaContradicts && itemById.has(metaContradicts)) {
      addPair(a.id, metaContradicts, "Contradição explícita declarada em metadata.contradicts.");
    }

    for (let j = i + 1; j < governedItems.length; j++) {
      const b = governedItems[j]!;
      if (a.id === b.id) continue;
      if (a.domainId !== b.domainId || a.type !== b.type) continue;

      const sameTitle = normalizeTitle(a.title) === normalizeTitle(b.title);
      const overlappingTags = shareAnyTag(a.tags, b.tags);

      if (sameTitle && a.status !== b.status) {
        addPair(
          a.id,
          b.id,
          `Mesmo título e domínio (${a.domainId}) com status conflitantes ('${a.status}' vs '${b.status}').`
        );
      } else if (sameTitle && a.status === "approved" && b.status === "approved" && a.contentHash !== b.contentHash) {
        addPair(a.id, b.id, `Dois itens 'approved' duplicados no domínio ${a.domainId} com conteúdo divergente.`);
      } else if (
        overlappingTags &&
        ((a.status === "approved" && b.status === "deprecated") ||
          (a.status === "deprecated" && b.status === "approved")) &&
        (a.relatedIds.includes(b.id) || b.relatedIds.includes(a.id))
      ) {
        addPair(
          a.id,
          b.id,
          `Itens relacionados no domínio ${a.domainId} com tags compartilhadas e status conflitantes ('${a.status}' vs '${b.status}').`
        );
      }
    }
  }

  return pairs;
}

/**
 * Knowledge Health Monitor: detecta regras críticas/altas sem testes VERIFIED_BY,
 * contradições entre regras/ADRs, itens sem sourceUri/acceptanceCriteria,
 * itens obsoletos e conflitos de precedência entre fontes (Git > API > Connector > Agent).
 */
export function computeProjectHealthReport(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[],
  now = new Date(),
  staleDays = 90
): ProjectHealthReport {
  const approvedRules = items.filter((i) => i.type === "business_rule" && i.status === "approved");
  const untestedRuleIds: string[] = [];
  const uncoveredCriticalRuleIds: string[] = [];

  for (const rule of approvedRules) {
    const hasVerification = edges.some(
      (e) => e.relationType === "VERIFIED_BY" && (e.toItemId === rule.id || e.fromItemId === rule.id)
    );
    if (!hasVerification) {
      untestedRuleIds.push(rule.id);
      if (isHighOrCritical(rule)) {
        uncoveredCriticalRuleIds.push(rule.id);
      }
    }
  }

  const contradictoryItems = detectContradictions(items, edges);

  const activeItems = items.filter((i) => i.status !== "deprecated" && i.status !== "superseded");
  const missingSourceUriIds = activeItems
    .filter((i) => !i.sourceUri || i.sourceUri.trim() === "")
    .map((i) => i.id);

  const missingAcceptanceCriteriaIds = activeItems
    .filter(
      (i) =>
        (i.type === "business_rule" || i.type === "requirement" || i.type === "feature") &&
        !hasAcceptanceCriteria(i)
    )
    .map((i) => i.id);

  const staleThreshold = now.getTime() - staleDays * 24 * 60 * 60_000;
  const staleItemIds = items
    .filter((i) => i.status !== "deprecated" && new Date(i.updatedAt).getTime() < staleThreshold)
    .map((i) => i.id);

  // Conflitos de precedência entre fontes (mesmo ID com hashes diferentes)
  const groupedById = new Map<string, KnowledgeItem[]>();
  for (const item of items) {
    const list = groupedById.get(item.id) ?? [];
    list.push(item);
    groupedById.set(item.id, list);
  }

  const gitVsConnectorConflicts: ProjectHealthReport["gitVsConnectorConflicts"] = [];
  const precedenceConflicts: PrecedenceConflict[] = [];

  for (const [id, versions] of groupedById) {
    const uniqueHashes = new Set(versions.map((v) => v.contentHash));
    const uniqueSources = new Set(versions.map((v) => v.sourceKind));
    if (versions.length > 1 && uniqueHashes.size > 1 && uniqueSources.size > 1) {
      const sorted = [...versions].sort((a, b) => {
        const originDiff = (a.sourceOrigin === "internal" ? 1 : 0) - (b.sourceOrigin === "internal" ? 1 : 0);
        if (originDiff !== 0) return -originDiff;
        return SOURCE_PRECEDENCE[b.sourceKind] - SOURCE_PRECEDENCE[a.sourceKind];
      });
      precedenceConflicts.push({
        id,
        winningSourceKind: sorted[0]!.sourceKind,
        sources: versions.map((v) => ({
          sourceKind: v.sourceKind,
          sourceOrigin: v.sourceOrigin,
          contentHash: v.contentHash
        }))
      });
    }

    const gitItem = versions.find((v) => v.sourceKind === "git");
    const connectorItem = versions.find((v) => v.sourceKind === "connector");
    if (gitItem && connectorItem && gitItem.contentHash !== connectorItem.contentHash) {
      gitVsConnectorConflicts.push({
        id,
        gitHash: gitItem.contentHash,
        connectorHash: connectorItem.contentHash
      });
    }
  }

  const penalty =
    uncoveredCriticalRuleIds.length * 15 +
    (untestedRuleIds.length - uncoveredCriticalRuleIds.length) * 8 +
    contradictoryItems.length * 15 +
    missingSourceUriIds.length * 5 +
    missingAcceptanceCriteriaIds.length * 5 +
    staleItemIds.length * 4 +
    precedenceConflicts.length * 12;

  return {
    healthScore: Math.max(0, 100 - penalty),
    untestedRuleIds,
    uncoveredCriticalRuleIds,
    contradictoryItems,
    missingSourceUriIds,
    missingAcceptanceCriteriaIds,
    staleItemIds,
    gitVsConnectorConflicts,
    precedenceConflicts
  };
}
