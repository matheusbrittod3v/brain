import type { KnowledgeItem } from "@brain/core";
import type { GraphEdge } from "@brain/graph";

export type TraceabilityGap = "NO_REQUIREMENT" | "NO_CODE_SYMBOL" | "NO_TEST";

export interface RuleTraceabilityLink {
  ruleId: string;
  requirements: string[];
  codeSymbols: string[];
  tests: string[];
  uncovered: boolean;
  uncoveredCritical: boolean;
  gaps: TraceabilityGap[];
}

export interface BusinessTraceabilityReport {
  matrix: RuleTraceabilityLink[];
  totalRules: number;
  coveredRules: number;
  uncoveredRules: RuleTraceabilityLink[];
  uncoveredCriticalRules: RuleTraceabilityLink[];
  coverageRatio: number;
}

function getOtherEndpoint(edge: GraphEdge, id: string): string | null {
  if (edge.fromItemId === id) return edge.toItemId;
  if (edge.toItemId === id) return edge.fromItemId;
  return null;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Builds a full Rule -> Requirement -> CodeSymbol -> Test traceability matrix
 * from KnowledgeItems and GraphEdges, flagging uncovered and critical uncovered rules.
 */
export function buildBusinessTraceabilityMatrix(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[]
): RuleTraceabilityLink[] {
  const itemById = new Map<string, KnowledgeItem>(items.map((item) => [item.id, item]));
  const rules = items.filter((i) => i.type === "business_rule" && i.status === "approved");

  return rules.map((rule) => {
    const reqSet = new Set<string>();
    const codeSet = new Set<string>();
    const testSet = new Set<string>();

    for (const relId of rule.relatedIds) {
      const target = itemById.get(relId);
      if (target?.type === "requirement") reqSet.add(relId);
      else if (target?.type === "code_symbol") codeSet.add(relId);
      else if (target?.type === "test") testSet.add(relId);
    }

    for (const edge of edges) {
      const other = getOtherEndpoint(edge, rule.id);
      if (!other) continue;
      const otherItem = itemById.get(other);

      if (otherItem?.type === "requirement") {
        reqSet.add(other);
      } else if (edge.relationType === "GOVERNED_BY" || edge.relationType === "IMPLEMENTS") {
        if (!otherItem || otherItem.type === "code_symbol") {
          codeSet.add(other);
        } else if (otherItem.type === "test") {
          testSet.add(other);
        }
      } else if (edge.relationType === "VERIFIED_BY") {
        if (!otherItem || otherItem.type === "test") {
          testSet.add(other);
        }
      }
    }

    // Traverse Requirement -> CodeSymbol and Requirement -> Test
    for (const reqId of [...reqSet]) {
      for (const edge of edges) {
        const other = getOtherEndpoint(edge, reqId);
        if (!other || other === rule.id) continue;
        const otherItem = itemById.get(other);

        if (
          (edge.relationType === "IMPLEMENTS" || edge.relationType === "GOVERNED_BY") &&
          (!otherItem || otherItem.type === "code_symbol")
        ) {
          codeSet.add(other);
        } else if (
          edge.relationType === "VERIFIED_BY" &&
          (!otherItem || otherItem.type === "test")
        ) {
          testSet.add(other);
        }
      }
    }

    // Traverse CodeSymbol -> Test
    for (const codeId of [...codeSet]) {
      for (const edge of edges) {
        if (edge.relationType !== "VERIFIED_BY") continue;
        const other = getOtherEndpoint(edge, codeId);
        if (!other || other === rule.id) continue;
        const otherItem = itemById.get(other);
        if (!otherItem || otherItem.type === "test") {
          testSet.add(other);
        }
      }
    }

    const requirements = uniqueSorted(reqSet);
    const codeSymbols = uniqueSorted(codeSet);
    const tests = uniqueSorted(testSet);

    const gaps: TraceabilityGap[] = [];
    if (requirements.length === 0) gaps.push("NO_REQUIREMENT");
    if (codeSymbols.length === 0) gaps.push("NO_CODE_SYMBOL");
    if (tests.length === 0) gaps.push("NO_TEST");

    const priority = String(rule.metadata?.priority ?? "medium");
    const uncovered = codeSymbols.length === 0 || tests.length === 0;
    const uncoveredCritical =
      (priority === "high" || priority === "critical") && tests.length === 0;

    return {
      ruleId: rule.id,
      requirements,
      codeSymbols,
      tests,
      uncovered,
      uncoveredCritical,
      gaps
    };
  });
}

export function buildTraceabilityReport(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[]
): BusinessTraceabilityReport {
  const matrix = buildBusinessTraceabilityMatrix(items, edges);
  const uncoveredRules = matrix.filter((link) => link.uncovered);
  const uncoveredCriticalRules = matrix.filter((link) => link.uncoveredCritical);
  const coveredRules = matrix.length - uncoveredRules.length;
  const coverageRatio = matrix.length === 0 ? 1 : coveredRules / matrix.length;

  return {
    matrix,
    totalRules: matrix.length,
    coveredRules,
    uncoveredRules,
    uncoveredCriticalRules,
    coverageRatio
  };
}
