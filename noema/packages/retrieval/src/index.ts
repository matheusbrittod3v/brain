import type { AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";
import type { KnowledgeGraphStore } from "@noema/graph";

export interface SearchQuery {
  projectId: string;
  query: string;
  domains?: number[];
  limit?: number;
  explain?: boolean;
  queryEmbedding?: readonly number[];
  atDate?: string;
}

export interface SearchExplain {
  lexicalScore: number;
  vectorScore?: number;
  rrfScore?: number;
  graphProximity: number;
  authorityWeight: number;
  recencyDecay: number;
  hitRateBoost: number;
}

export interface SearchHit {
  item: KnowledgeItem;
  score: number;
  explain?: SearchExplain;
}

const RRF_K = 60;
const MAX_POSSIBLE_RRF = 2 / (RRF_K + 1);

function itemKey(projectId: string, itemId: string): string {
  return JSON.stringify([projectId, itemId]);
}

function parseAtDateMs(atDate: string | undefined): number | undefined {
  if (atDate === undefined) return undefined;
  const parsed = Date.parse(atDate);
  if (Number.isNaN(parsed)) {
    throw new Error("SearchQuery.atDate must be a valid ISO-8601 date string.");
  }
  return parsed;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

export class HybridRetrievalEngine {
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly embeddings = new Map<string, readonly number[]>();
  private readonly hitBoosts = new Map<string, number>();

  constructor(private readonly graph: KnowledgeGraphStore) {}

  upsertItem(item: KnowledgeItem, embedding?: readonly number[]): void {
    const key = `${item.tenantId}:${item.projectId}:${item.id}`;
    this.items.set(key, item);
    if (embedding) {
      this.embeddings.set(key, embedding);
    }
  }

  setEmbedding(tenantId: string, projectId: string, itemId: string, embedding: readonly number[]): void {
    this.embeddings.set(`${tenantId}:${projectId}:${itemId}`, embedding);
  }

  getItem(ctx: AuthContext, projectId: string, id: string): KnowledgeItem | undefined {
    if (!ctx.allowedProjects.includes(projectId)) return undefined;
    const item = this.items.get(`${ctx.tenantId}:${projectId}:${id}`);
    if (!item || item.deletedAt) return undefined;
    if (!ctx.allowedProjects.includes(item.projectId)) return undefined;
    if (!ctx.allowedPolicies.includes(item.accessPolicyId)) return undefined;
    return item;
  }

  recordHitBoost(projectId: string, itemId: string, delta = 0.2): void {
    const key = itemKey(projectId, itemId);
    const prev = this.hitBoosts.get(key) ?? 0;
    this.hitBoosts.set(key, Math.min(1.0, prev + delta));
  }

  /**
   * Busca híbrida com pré-filtro estrito de tenant, projeto autorizado, accessPolicyId e janela temporal.
   */
  search(ctx: AuthContext, q: SearchQuery): SearchHit[] {
    const atDateMs = parseAtDateMs(q.atDate);
    const allowedProjects = new Set(ctx.allowedProjects);
    if (!allowedProjects.has(q.projectId)) {
      return [];
    }

    const effectiveMs = atDateMs ?? Date.now();
    const allowed = new Set(ctx.allowedPolicies);
    const terms = q.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    const candidates: KnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (item.tenantId !== ctx.tenantId) continue;
      if (item.projectId !== q.projectId && item.projectId !== "__org__") continue;
      if (!allowedProjects.has(item.projectId)) continue;
      if (item.deletedAt) continue;
      if (item.status === "deprecated" || item.status === "superseded") continue;
      if (!allowed.has(item.accessPolicyId)) continue;
      if (q.domains && q.domains.length > 0 && !q.domains.includes(item.domainId)) continue;
      if (item.validFrom) {
        const fromMs = Date.parse(item.validFrom);
        if (!Number.isNaN(fromMs) && fromMs > effectiveMs) continue;
      }
      if (item.validUntil) {
        const untilMs = Date.parse(item.validUntil);
        if (!Number.isNaN(untilMs) && untilMs <= effectiveMs) continue;
      }
      candidates.push(item);
    }

    if (candidates.length === 0) {
      return [];
    }

    // Lexical score [0..1]
    const lexicalScores = new Map<string, number>();
    for (const item of candidates) {
      const key = itemKey(item.projectId, item.id);
      const hay = `${item.id} ${item.type} ${item.title} ${item.summary ?? ""} ${item.content} ${item.tags.join(" ")}`.toLowerCase();
      const hayWords = hay.split(/[^a-z0-9_]+/).filter((w) => w.length >= 5);
      let matches = 0;
      for (const t of terms) {
        if (hay.includes(t)) {
          matches += 1;
        } else if (t.length >= 6 && hayWords.some((w) => t.includes(w))) {
          matches += 0.5;
        }
      }
      const score = terms.length > 0 ? matches / terms.length : 0.1;
      lexicalScores.set(key, score);
    }

    // Optional vector cosine similarity + RRF
    const hasQueryEmbedding = Array.isArray(q.queryEmbedding) && q.queryEmbedding.length > 0;
    const vectorScores = new Map<string, number>();
    const relevanceScores = new Map<string, { lex: number; vec: number; rrf: number; combined: number }>();

    if (hasQueryEmbedding && q.queryEmbedding) {
      for (const item of candidates) {
        const key = itemKey(item.projectId, item.id);
        const storedVec =
          this.embeddings.get(`${item.tenantId}:${item.projectId}:${item.id}`) ??
          (Array.isArray(item.metadata?.embedding) ? (item.metadata.embedding as readonly number[]) : undefined);
        const sim = storedVec ? cosineSimilarity(q.queryEmbedding, storedVec) : 0;
        vectorScores.set(key, sim);
      }

      const lexRanked = [...candidates]
        .filter((item) => (lexicalScores.get(itemKey(item.projectId, item.id)) ?? 0) > 0)
        .sort(
          (a, b) =>
            (lexicalScores.get(itemKey(b.projectId, b.id)) ?? 0) -
            (lexicalScores.get(itemKey(a.projectId, a.id)) ?? 0)
        );
      const vecRanked = [...candidates]
        .filter((item) => (vectorScores.get(itemKey(item.projectId, item.id)) ?? 0) > 0)
        .sort(
          (a, b) =>
            (vectorScores.get(itemKey(b.projectId, b.id)) ?? 0) -
            (vectorScores.get(itemKey(a.projectId, a.id)) ?? 0)
        );

      const lexRankPos = new Map<string, number>();
      lexRanked.forEach((item, idx) => lexRankPos.set(itemKey(item.projectId, item.id), idx + 1));
      const vecRankPos = new Map<string, number>();
      vecRanked.forEach((item, idx) => vecRankPos.set(itemKey(item.projectId, item.id), idx + 1));

      for (const item of candidates) {
        const key = itemKey(item.projectId, item.id);
        const lex = lexicalScores.get(key) ?? 0;
        const vec = vectorScores.get(key) ?? 0;
        const lRank = lexRankPos.get(key);
        const vRank = vecRankPos.get(key);
        const rawRrf = (lRank ? 1 / (RRF_K + lRank) : 0) + (vRank ? 1 / (RRF_K + vRank) : 0);
        const normalizedRrf = Math.min(1, rawRrf / MAX_POSSIBLE_RRF);
        relevanceScores.set(key, { lex, vec, rrf: normalizedRrf, combined: normalizedRrf });
      }
    } else {
      for (const item of candidates) {
        const key = itemKey(item.projectId, item.id);
        const lex = lexicalScores.get(key) ?? 0;
        relevanceScores.set(key, { lex, vec: 0, rrf: lex, combined: lex });
      }
    }

    // Expansão no grafo a partir dos melhores candidatos
    const topSeeds = [...candidates]
      .sort(
        (a, b) =>
          (relevanceScores.get(itemKey(b.projectId, b.id))?.combined ?? 0) -
          (relevanceScores.get(itemKey(a.projectId, a.id))?.combined ?? 0)
      )
      .slice(0, 3);

    const graphProximity = new Map<string, number>();
    for (const seed of topSeeds) {
      if ((relevanceScores.get(itemKey(seed.projectId, seed.id))?.combined ?? 0) === 0) continue;
      for (const hit of this.graph.traverseRelated(ctx, { projectId: seed.projectId, itemId: seed.id }, 2)) {
        if (!allowedProjects.has(hit.projectId)) continue;
        const prox = 1 / (1 + hit.hops);
        const key = itemKey(hit.projectId, hit.itemId);
        graphProximity.set(key, Math.max(graphProximity.get(key) ?? 0, prox));
      }
    }

    const nowMs = Date.now();
    const ranked: SearchHit[] = candidates
      .map((item) => {
        const key = itemKey(item.projectId, item.id);
        const rel = relevanceScores.get(key) ?? { lex: 0, vec: 0, rrf: 0, combined: 0 };
        const gProx = graphProximity.get(key) ?? 0;
        const authWeight =
          item.trustLevel === "untrusted" ? 0.2 : item.status === "approved" ? 1.0 : 0.5;
        const ageDays = Math.max(0, (nowMs - Date.parse(item.updatedAt)) / 86_400_000);
        const recency = Math.exp(-ageDays / 90);
        const boost = this.hitBoosts.get(key) ?? 0;

        const score =
          0.45 * rel.combined + 0.25 * gProx + 0.15 * authWeight + 0.1 * recency + 0.05 * boost;
        return {
          item,
          score,
          ...(q.explain
            ? {
                explain: {
                  lexicalScore: rel.lex,
                  ...(hasQueryEmbedding ? { vectorScore: rel.vec, rrfScore: rel.rrf } : {}),
                  graphProximity: gProx,
                  authorityWeight: authWeight,
                  recencyDecay: recency,
                  hitRateBoost: boost
                }
              }
            : {})
        };
      })
      .filter((r) => {
        const key = itemKey(r.item.projectId, r.item.id);
        const rel = relevanceScores.get(key)?.combined ?? 0;
        const gProx = graphProximity.get(key) ?? 0;
        return q.explain ? rel > 0 || gProx > 0 : r.score > 0.2 && (rel > 0 || gProx > 0);
      })
      .sort((a, b) => {
        if (Math.abs(b.score - a.score) < 0.01) {
          if (a.item.status === "approved" && b.item.status !== "approved") return -1;
          if (b.item.status === "approved" && a.item.status !== "approved") return 1;
          if (!a.item.isInferred && b.item.isInferred) return -1;
          if (a.item.isInferred && !b.item.isInferred) return 1;
        }
        return b.score - a.score;
      });

    return ranked.slice(0, q.limit ?? 10);
  }
}

export {
  type RlsSessionContext,
  type SqlSearchQuery,
  type SqlSearchExplain,
  type SqlSearchHit,
  type RetrievalSqlParameter,
  type RetrievalSqlTransactionRunner,
  type RetrievalSqlClient,
  type RetrievalPostgresTarget,
  type PostgresRetrievalEngineOptions,
  type RetrievalCacheBackend,
  type AsyncRetrievalEngine,
  type RetrievalKnowledgeItemRow,
  type RetrievalVectorRankRow,
  type RetrievalGraphWalkRow,
  PostgresRetrievalEngine,
  SqlRetrievalEngine,
  createPostgresRetrievalEngine,
  createPostgresRetrievalEngineForTesting
} from "./sql-retrieval.js";


