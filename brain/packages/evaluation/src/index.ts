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

export interface SearchBenchmarkCase<TExtra = unknown> {
  id: string;
  query: string;
  expectedIds: readonly string[];
  forbiddenIds?: readonly string[];
  meta?: TExtra;
}

export interface SearchBenchmarkCaseResult<TDetail = unknown> {
  id: string;
  returnedIds: string[];
  hitAt1: boolean;
  recallAt5: number;
  reciprocalRank: number;
  latencyMs: number;
  leakageCount: number;
  detail?: TDetail;
}

export interface SearchBenchmarkReport<TDetail = unknown> {
  summary: {
    totalQuestions: number;
    hitRateAt1: number;
    meanRecallAt5: number;
    mrr: number;
    avgLatencyMs: number;
    leakageCount: number;
  };
  cases: SearchBenchmarkCaseResult<TDetail>[];
}

export async function evaluateSearchBenchmark<TExtra = unknown, TDetail = unknown>(
  questions: readonly SearchBenchmarkCase<TExtra>[],
  runQuery: (
    q: SearchBenchmarkCase<TExtra>
  ) => Promise<{ returnedIds: string[]; latencyMs?: number; detail?: TDetail }> | { returnedIds: string[]; latencyMs?: number; detail?: TDetail }
): Promise<SearchBenchmarkReport<TDetail>> {
  const cases = await Promise.all(
    questions.map(async (q) => {
      const started = Date.now();
      const res = await runQuery(q);
      const latencyMs = res.latencyMs ?? Date.now() - started;
      const returnedIds = res.returnedIds;
      const returnedSet = new Set(returnedIds);
      const firstMatchRank = returnedIds.findIndex((id) => q.expectedIds.includes(id)) + 1;
      const hitAt1 = firstMatchRank === 1;
      const recallAt5 =
        q.expectedIds.filter((eid) => returnedSet.has(eid)).length / Math.max(1, q.expectedIds.length);
      const reciprocalRank = firstMatchRank > 0 ? 1 / firstMatchRank : 0;
      const leakageCount = (q.forbiddenIds ?? []).filter((fid) => returnedSet.has(fid)).length;

      return {
        id: q.id,
        returnedIds,
        hitAt1,
        recallAt5: Number(recallAt5.toFixed(3)),
        reciprocalRank: Number(reciprocalRank.toFixed(3)),
        latencyMs,
        leakageCount,
        detail: res.detail
      };
    })
  );

  const total = Math.max(1, cases.length);
  return {
    summary: {
      totalQuestions: cases.length,
      hitRateAt1: Number((cases.filter((c) => c.hitAt1).length / total).toFixed(3)),
      meanRecallAt5: Number((cases.reduce((acc, c) => acc + c.recallAt5, 0) / total).toFixed(3)),
      mrr: Number((cases.reduce((acc, c) => acc + c.reciprocalRank, 0) / total).toFixed(3)),
      avgLatencyMs: Math.round(cases.reduce((acc, c) => acc + c.latencyMs, 0) / total),
      leakageCount: cases.reduce((acc, c) => acc + c.leakageCount, 0)
    },
    cases
  };
}

