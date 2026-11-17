export interface EvalCase {
  id: string;
  query: string;
  projectId: string;
  expectedIds: string[];
  forbiddenIds: string[];
}

export interface EvalMetrics {
  totalCases: number;
  precisionAtK: number;
  recallAtK: number;
  leakageCount: number;
}

export function evaluateRetrievalBatch(
  cases: readonly EvalCase[],
  runQuery: (c: EvalCase) => string[]
): EvalMetrics {
  let sumPrecision = 0;
  let sumRecall = 0;
  let leakageCount = 0;

  for (const c of cases) {
    const retrieved = runQuery(c);
    const retrievedSet = new Set(retrieved);
    const hits = c.expectedIds.filter((id) => retrievedSet.has(id)).length;
    for (const forbidden of c.forbiddenIds) {
      if (retrievedSet.has(forbidden)) leakageCount += 1;
    }
    sumPrecision += retrieved.length > 0 ? hits / retrieved.length : 0;
    sumRecall += c.expectedIds.length > 0 ? hits / c.expectedIds.length : 1;
  }

  const n = Math.max(1, cases.length);
  return {
    totalCases: cases.length,
    precisionAtK: sumPrecision / n,
    recallAtK: sumRecall / n,
    leakageCount
  };
}

