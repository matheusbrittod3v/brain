import { createHash } from "node:crypto";
import type { AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext
} from "@brain/database";
import type { GraphStoreContract, TraversalHit } from "@brain/graph";
import {
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  LruQueryCache,
  RRF_K,
  compositeItemKey,
  computeLexicalFallbackScore,
  computePolicyHash,
  mapRowToKnowledgeItem,
  parseAtDate,
  parseIsoOrString,
  requireToken,
  validateDomainFilter,
  validateQueryEmbedding
} from "./helpers.js";
import { traverseGraphInTransaction } from "./graph-traversal.js";
import {
  UNSAFE_RAW_SQL_TEST_SEAM,
  assertVerifiedAppPostgresClient,
  isUnsafeTestSeamTarget,
  type AsyncRetrievalEngine,
  type PostgresRetrievalEngineOptions,
  type RetrievalCacheBackend,
  type RetrievalKnowledgeItemRow,
  type RetrievalPostgresTarget,
  type RetrievalSqlClient,
  type RetrievalSqlTransactionRunner,
  type RetrievalVectorRankRow,
  type SqlSearchHit,
  type SqlSearchQuery,
  type UnsafeTestSeamTarget
} from "./types.js";

export class PostgresRetrievalEngine<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
> implements AsyncRetrievalEngine {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly graph?: GraphStoreContract;
  private readonly now: () => Date;
  private readonly hitBoosts = new Map<string, number>();
  private readonly queryCache: LruQueryCache;
  private readonly externalCache?: RetrievalCacheBackend;
  private readonly cacheTtlMs: number;
  private readonly rerankUrl?: string;

  constructor(
    clientOrOptions: RetrievalPostgresTarget<TTx> | PostgresRetrievalEngineOptions<TTx>,
    maybeGraph?: GraphStoreContract,
    maybeOptions?: { now?: () => Date; cache?: RetrievalCacheBackend; cacheTtlMs?: number; cacheMaxEntries?: number; rerankUrl?: string }
  ) {
    let target: unknown;
    let graph: GraphStoreContract | undefined;
    let now: (() => Date) | undefined;
    let cache: RetrievalCacheBackend | undefined;
    let cacheTtlMs: number | undefined;
    let cacheMaxEntries: number | undefined;
    let rerankUrl: string | undefined;

    if (
      clientOrOptions &&
      typeof clientOrOptions === "object" &&
      ("client" in clientOrOptions || "sql" in clientOrOptions) &&
      !("withRlsTransaction" in clientOrOptions) &&
      !("begin" in clientOrOptions) &&
      !isUnsafeTestSeamTarget(clientOrOptions)
    ) {
      target = "client" in clientOrOptions ? clientOrOptions.client : clientOrOptions.sql;
      graph = clientOrOptions.graph;
      now = clientOrOptions.now;
      cache = clientOrOptions.cache;
      cacheTtlMs = clientOrOptions.cacheTtlMs;
      cacheMaxEntries = clientOrOptions.cacheMaxEntries;
      rerankUrl = clientOrOptions.rerankUrl;
    } else {
      target = clientOrOptions;
      graph = maybeGraph;
      now = maybeOptions?.now;
      cache = maybeOptions?.cache;
      cacheTtlMs = maybeOptions?.cacheTtlMs;
      cacheMaxEntries = maybeOptions?.cacheMaxEntries;
      rerankUrl = maybeOptions?.rerankUrl;
    }

    if (isUnsafeTestSeamTarget<TTx>(target)) {
      const sqlClient = target.sql;
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(sqlClient, ctx, cb);
    } else {
      const appClient = assertVerifiedAppPostgresClient<TTx>(target);
      this.runInRlsTransaction = (ctx, cb) => appClient.withRlsTransaction(ctx, cb);
    }

    this.graph = graph;
    this.now = now ?? (() => new Date());
    this.externalCache = cache;
    this.rerankUrl = rerankUrl ?? process.env.AI_WORKER_URL;
    this.cacheTtlMs = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.queryCache = new LruQueryCache(
      cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      this.cacheTtlMs,
      this.now
    );
  }

  invalidateCache(tenantId: string, projectId?: string): void {
    const normTenant = requireToken(tenantId, "tenantId");
    const normProj = projectId !== undefined ? requireToken(projectId, "projectId") : undefined;
    this.queryCache.invalidate(normTenant, normProj);
    if (this.externalCache?.invalidateByPrefix) {
      const prefix = normProj !== undefined ? `${normTenant}:${normProj}:` : `${normTenant}:`;
      void this.externalCache.invalidateByPrefix(prefix);
    }
  }

  recordHitBoost(projectId: string, itemId: string, delta = 0.2): void {
    const normProj = requireToken(projectId, "projectId");
    const normItem = requireToken(itemId, "itemId");
    const key = compositeItemKey(normProj, normItem);
    const prev = this.hitBoosts.get(key) ?? 0;
    this.hitBoosts.set(key, Math.min(1.0, Math.max(0, prev + delta)));
  }

  private resolveAuthorizedScope(
    ctx: AuthContext,
    requestedProjectId: string
  ):
    | {
        authorized: true;
        rlsContext: RlsSessionContext;
        resolved: ResolvedRlsSessionGucs;
        normalizedProjectId: string;
        allowedProjects: Set<string>;
        allowedPolicies: Set<string>;
        candidateProjectsCsv: string;
      }
    | { authorized: false } {
    if (!ctx || typeof ctx !== "object") {
      throw new Error("AuthContext must be a non-null object.");
    }
    const normalizedProjectId = requireToken(requestedProjectId, "projectId");

    if (!Array.isArray(ctx.allowedProjects) || ctx.allowedProjects.length === 0) {
      return { authorized: false };
    }
    if (!Array.isArray(ctx.allowedPolicies) || ctx.allowedPolicies.length === 0) {
      return { authorized: false };
    }

    const rlsContext: RlsSessionContext = {
      tenantId: ctx.tenantId,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies
    };
    const resolved = resolveRlsSessionContext(rlsContext);
    const allowedProjects = new Set(resolved.allowedProjectsCsv.split(","));
    const allowedPolicies = new Set(resolved.allowedPoliciesCsv.split(","));

    if (!allowedProjects.has(normalizedProjectId)) {
      return { authorized: false };
    }

    const candidateProjects = [normalizedProjectId];
    if (normalizedProjectId !== "__org__" && allowedProjects.has("__org__")) {
      candidateProjects.push("__org__");
    }

    return {
      authorized: true,
      rlsContext: {
        tenantId: resolved.tenantId,
        allowedProjects: [...allowedProjects],
        allowedPolicies: [...allowedPolicies]
      },
      resolved,
      normalizedProjectId,
      allowedProjects,
      allowedPolicies,
      candidateProjectsCsv: candidateProjects.join(",")
    };
  }

  async getItem(
    ctx: AuthContext,
    projectId: string,
    id: string
  ): Promise<KnowledgeItem | undefined> {
    const normalizedId = requireToken(id, "id");
    const scope = this.resolveAuthorizedScope(ctx, projectId);
    if (!scope.authorized) {
      return undefined;
    }

    const nowIso = this.now().toISOString();

    return this.runInRlsTransaction(scope.rlsContext, async (tx) => {
      const rows = await tx<RetrievalKnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, hit_count, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${scope.resolved.tenantId}
        AND project_id = ${scope.normalizedProjectId}
        AND id = ${normalizedId}
        AND access_policy_id = ANY(string_to_array(${scope.resolved.allowedPoliciesCsv}, ','))
        AND deleted_at IS NULL
        AND (valid_until IS NULL OR valid_until > ${nowIso}::timestamptz)`;

      const row = rows[0];
      if (!row) return undefined;
      if (!scope.allowedProjects.has(String(row.project_id))) return undefined;
      if (!scope.allowedPolicies.has(String(row.access_policy_id))) return undefined;
      return mapRowToKnowledgeItem(row);
    });
  }

  async search(ctx: AuthContext, q: SqlSearchQuery): Promise<SqlSearchHit[]> {
    if (!q || typeof q !== "object") {
      throw new Error("SearchQuery must be a non-null object.");
    }
    if (typeof q.query !== "string") {
      throw new Error("SearchQuery.query must be a string.");
    }
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit <= 0)) {
      throw new Error("SearchQuery.limit must be a positive integer.");
    }

    const domainsCsv = validateDomainFilter(q.domains);
    const vectorLiteral = validateQueryEmbedding(q.queryEmbedding);
    const embeddingModel = q.embeddingModel ? requireToken(q.embeddingModel, "embeddingModel") : "bge-m3";
    const atDateParsed = parseAtDate(q.atDate);

    const scope = this.resolveAuthorizedScope(ctx, q.projectId);
    if (!scope.authorized) {
      return [];
    }

    const normalizedQuery = q.query.trim();
    const policyHash = computePolicyHash(scope.allowedProjects, scope.allowedPolicies);
    const embeddingHash =
      vectorLiteral !== undefined
        ? createHash("sha256").update(`${embeddingModel}:${vectorLiteral}`).digest("hex").slice(0, 12)
        : "";
    const cacheKey = `${scope.resolved.tenantId}:${scope.normalizedProjectId}:${policyHash}:${normalizedQuery}:${atDateParsed?.iso ?? ""}:${domainsCsv}:${q.limit ?? 10}:${Boolean(q.explain)}:${embeddingHash}`;

    const cached = this.queryCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (this.externalCache) {
      const extRaw = await this.externalCache.get(cacheKey);
      if (typeof extRaw === "string" && extRaw.length > 0) {
        try {
          const parsed = JSON.parse(extRaw) as SqlSearchHit[];
          if (Array.isArray(parsed)) {
            this.queryCache.set(cacheKey, scope.resolved.tenantId, scope.normalizedProjectId, parsed);
            return parsed;
          }
        } catch {
          // Ignore corrupted cache entry and fall through to DB
        }
      }
    }

    const terms = normalizedQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const nowMs = nowDate.getTime();
    const effectiveIso = atDateParsed?.iso ?? nowIso;
    const effectiveMs = atDateParsed?.ms ?? nowMs;

    const results = await this.runInRlsTransaction(scope.rlsContext, async (tx) => {
      const candidateRows = await tx<RetrievalKnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, hit_count, context_sent_count, context_hit_count, metadata, deleted_at, created_at, updated_at,
        CASE
          WHEN ${normalizedQuery} = '' THEN 0.1
          ELSE brain_bm25_rank(search_vector, id, title, summary, content, ${normalizedQuery})
        END AS lexical_rank
      FROM knowledge_items
      WHERE tenant_id = ${scope.resolved.tenantId}
        AND project_id = ANY(string_to_array(${scope.candidateProjectsCsv}, ','))
        AND access_policy_id = ANY(string_to_array(${scope.resolved.allowedPoliciesCsv}, ','))
        AND deleted_at IS NULL
        AND status NOT IN ('deprecated', 'superseded')
        AND (valid_from IS NULL OR valid_from <= ${effectiveIso}::timestamptz)
        AND (valid_until IS NULL OR valid_until > ${effectiveIso}::timestamptz)
        AND (${domainsCsv} = '' OR domain_id = ANY(string_to_array(${domainsCsv}, ',')::smallint[]))`;

      const candidates: KnowledgeItem[] = [];
      const rawLexicalRanks = new Map<string, number>();
      const persistentHitRates = new Map<string, number>();

      for (const row of candidateRows) {
        const projId = String(row.project_id);
        const polId = String(row.access_policy_id);
        if (!scope.allowedProjects.has(projId)) continue;
        if (projId !== scope.normalizedProjectId && projId !== "__org__") continue;
        if (!scope.allowedPolicies.has(polId)) continue;
        if (row.deleted_at !== null && row.deleted_at !== undefined) continue;
        if (row.status === "deprecated" || row.status === "superseded") continue;
        if (row.valid_from !== null && row.valid_from !== undefined) {
          const fromMs = Date.parse(parseIsoOrString(row.valid_from));
          if (!Number.isNaN(fromMs) && fromMs > effectiveMs) continue;
        }
        if (row.valid_until !== null && row.valid_until !== undefined) {
          const untilMs = Date.parse(parseIsoOrString(row.valid_until));
          if (!Number.isNaN(untilMs) && untilMs <= effectiveMs) continue;
        }
        if (q.domains && q.domains.length > 0 && !q.domains.includes(Number(row.domain_id))) continue;

        const item = mapRowToKnowledgeItem(row);
        const key = compositeItemKey(item.projectId, item.id);
        candidates.push(item);
        const sent = Math.max(0, Number(row.context_sent_count ?? 0));
        const hits = Math.max(0, Number(row.context_hit_count ?? 0));
        persistentHitRates.set(key, sent > 0 ? Math.min(1, hits / sent) : 0);

        if (row.lexical_rank !== undefined && row.lexical_rank !== null) {
          const numRank = Number(row.lexical_rank);
          rawLexicalRanks.set(key, Number.isFinite(numRank) ? Math.max(0, numRank) : 0);
        } else {
          rawLexicalRanks.set(key, computeLexicalFallbackScore(item, terms));
        }
      }

      if (candidates.length === 0) {
        return [];
      }

      const maxLexical = Math.max(0, ...rawLexicalRanks.values());
      const lexicalScores = new Map<string, number>();
      for (const item of candidates) {
        const key = compositeItemKey(item.projectId, item.id);
        const raw = rawLexicalRanks.get(key) ?? 0;
        const normalized = maxLexical > 1 ? raw / maxLexical : Math.min(1, raw);
        lexicalScores.set(key, normalized);
      }

      const vectorScores = new Map<string, number>();
      if (vectorLiteral !== undefined) {
        const vecRows = await tx<RetrievalVectorRankRow>`SELECT
          ke.project_id,
          ke.knowledge_item_id,
          MAX(1 - (ke.embedding <=> ${vectorLiteral}::vector)) AS vector_similarity
        FROM knowledge_embeddings ke
        JOIN knowledge_items ki
          ON ki.tenant_id = ke.tenant_id
         AND ki.project_id = ke.project_id
         AND ki.id = ke.knowledge_item_id
        WHERE ke.tenant_id = ${scope.resolved.tenantId}
          AND ke.project_id = ANY(string_to_array(${scope.candidateProjectsCsv}, ','))
          AND ke.access_policy_id = ANY(string_to_array(${scope.resolved.allowedPoliciesCsv}, ','))
          AND ke.embedding_model = ${embeddingModel}
          AND ki.deleted_at IS NULL
          AND ki.status NOT IN ('deprecated', 'superseded')
          AND (ki.valid_from IS NULL OR ki.valid_from <= ${effectiveIso}::timestamptz)
          AND (ki.valid_until IS NULL OR ki.valid_until > ${effectiveIso}::timestamptz)
          AND (${domainsCsv} = '' OR ki.domain_id = ANY(string_to_array(${domainsCsv}, ',')::smallint[]))
        GROUP BY ke.project_id, ke.knowledge_item_id`;

        for (const vRow of vecRows) {
          const projId = String(vRow.project_id);
          const itemId = String(vRow.knowledge_item_id);
          if (!scope.allowedProjects.has(projId)) continue;
          const sim = Math.max(0, Math.min(1, Number(vRow.vector_similarity) || 0));
          vectorScores.set(compositeItemKey(projId, itemId), sim);
        }
      }

      const relevanceScores = new Map<string, { lex: number; vec: number; rrf: number; combined: number }>();
      if (vectorLiteral !== undefined) {
        const lexRanked = [...candidates]
          .filter((item) => (lexicalScores.get(compositeItemKey(item.projectId, item.id)) ?? 0) > 0)
          .sort(
            (a, b) =>
              (lexicalScores.get(compositeItemKey(b.projectId, b.id)) ?? 0) -
              (lexicalScores.get(compositeItemKey(a.projectId, a.id)) ?? 0)
          );
        const vecRanked = [...candidates]
          .filter((item) => (vectorScores.get(compositeItemKey(item.projectId, item.id)) ?? 0) > 0)
          .sort(
            (a, b) =>
              (vectorScores.get(compositeItemKey(b.projectId, b.id)) ?? 0) -
              (vectorScores.get(compositeItemKey(a.projectId, a.id)) ?? 0)
          );

        const lexRankPos = new Map<string, number>();
        lexRanked.forEach((item, idx) => lexRankPos.set(compositeItemKey(item.projectId, item.id), idx + 1));
        const vecRankPos = new Map<string, number>();
        vecRanked.forEach((item, idx) => vecRankPos.set(compositeItemKey(item.projectId, item.id), idx + 1));

        const maxPossibleRrf = 2 / (RRF_K + 1);
        for (const item of candidates) {
          const key = compositeItemKey(item.projectId, item.id);
          const lex = lexicalScores.get(key) ?? 0;
          const vec = vectorScores.get(key) ?? 0;
          const lRank = lexRankPos.get(key);
          const vRank = vecRankPos.get(key);
          const rawRrf = (lRank ? 1 / (RRF_K + lRank) : 0) + (vRank ? 1 / (RRF_K + vRank) : 0);
          const normalizedRrf = maxPossibleRrf > 0 ? Math.min(1, rawRrf / maxPossibleRrf) : 0;
          relevanceScores.set(key, { lex, vec, rrf: normalizedRrf, combined: normalizedRrf });
        }
      } else {
        for (const item of candidates) {
          const key = compositeItemKey(item.projectId, item.id);
          const lex = lexicalScores.get(key) ?? 0;
          relevanceScores.set(key, { lex, vec: 0, rrf: lex, combined: lex });
        }
      }

      const topSeeds = [...candidates]
        .sort(
          (a, b) =>
            (relevanceScores.get(compositeItemKey(b.projectId, b.id))?.combined ?? 0) -
            (relevanceScores.get(compositeItemKey(a.projectId, a.id))?.combined ?? 0)
        )
        .slice(0, 3);

      const graphProximity = new Map<string, number>();
      for (const seed of topSeeds) {
        const seedKey = compositeItemKey(seed.projectId, seed.id);
        if ((relevanceScores.get(seedKey)?.combined ?? 0) === 0) continue;

        let traversalHits: TraversalHit[];
        if (this.graph) {
          traversalHits = await this.graph.traverseRelated(
            ctx,
            { projectId: seed.projectId, itemId: seed.id },
            2
          );
        } else {
          traversalHits = await traverseGraphInTransaction(
            tx,
            scope.resolved,
            scope.allowedProjects,
            seed.projectId,
            seed.id,
            2
          );
        }

        for (const hit of traversalHits) {
          if (!scope.allowedProjects.has(hit.projectId)) continue;
          const prox = 1 / (1 + hit.hops);
          const targetKey = compositeItemKey(hit.projectId, hit.itemId);
          graphProximity.set(targetKey, Math.max(graphProximity.get(targetKey) ?? 0, prox));
        }
      }

      const ranked: SqlSearchHit[] = candidates
        .map((item) => {
          const key = compositeItemKey(item.projectId, item.id);
          const rel = relevanceScores.get(key) ?? { lex: 0, vec: 0, rrf: 0, combined: 0 };
          const gProx = graphProximity.get(key) ?? 0;
          const authWeight =
            item.trustLevel === "untrusted" ? 0.2 : item.status === "approved" ? 1.0 : 0.5;
          const ageDays = Math.max(0, (nowMs - Date.parse(item.updatedAt)) / 86_400_000);
          const recency = Math.exp(-ageDays / 90);
          const persistedBoost = persistentHitRates.get(key) ?? 0;
          const boost = Math.min(1, persistedBoost + (this.hitBoosts.get(key) ?? 0));

          const score =
            0.45 * rel.combined +
            0.25 * gProx +
            0.15 * authWeight +
            0.1 * recency +
            0.05 * boost;

          return {
            item,
            score,
            ...(q.explain
              ? {
                  explain: {
                    lexicalScore: rel.lex,
                    ...(vectorLiteral !== undefined
                      ? { vectorScore: rel.vec, rrfScore: rel.rrf }
                      : {}),
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
          if (normalizedQuery === "" && vectorLiteral === undefined) {
            return true;
          }
          const key = compositeItemKey(r.item.projectId, r.item.id);
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
    });

    let finalResults = results;
    if (this.rerankUrl && normalizedQuery.length > 0 && results.length > 1) {
      try {
        const res = await fetch(`${this.rerankUrl.replace(/\/$/, "")}/rerank`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: normalizedQuery,
            documents: results.map((hit) => `${hit.item.title}\n${hit.item.content.slice(0, 1500)}`),
            top_n: results.length
          }),
          signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
          const payload = (await res.json()) as { results?: Array<{ index: number; score: number }> };
          if (Array.isArray(payload.results) && payload.results.length > 0) {
            const rerankByIndex = new Map(payload.results.map((entry) => [entry.index, entry.score]));
            finalResults = results
              .map((hit, index) => {
                const rrScore = rerankByIndex.get(index);
                if (rrScore === undefined || !Number.isFinite(rrScore)) return hit;
                const clamped = Math.max(0, Math.min(1, rrScore));
                return { ...hit, score: 0.7 * hit.score + 0.3 * clamped };
              })
              .sort((a, b) => b.score - a.score);
          }
        }
      } catch {
        // Fail-open to deterministic RRF + graph ranking if AI worker is unavailable
      }
    }

    this.queryCache.set(cacheKey, scope.resolved.tenantId, scope.normalizedProjectId, finalResults);
    if (this.externalCache) {
      await this.externalCache.set(
        cacheKey,
        JSON.stringify(finalResults),
        Math.max(1, Math.ceil(this.cacheTtlMs / 1000))
      );
    }
    return finalResults;
  }
}

export function createPostgresRetrievalEngine<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
>(
  clientOrOptions: RetrievalPostgresTarget<TTx> | PostgresRetrievalEngineOptions<TTx>,
  maybeGraph?: GraphStoreContract,
  maybeOptions?: { now?: () => Date }
): PostgresRetrievalEngine<TTx> {
  return new PostgresRetrievalEngine(clientOrOptions, maybeGraph, maybeOptions);
}

export function createPostgresRetrievalEngineForTesting<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
>(
  sql: RetrievalSqlClient<TTx>,
  maybeGraph?: GraphStoreContract,
  maybeOptions?: { now?: () => Date }
): PostgresRetrievalEngine<TTx> {
  if (!sql || typeof sql !== "object" || typeof sql.begin !== "function") {
    throw new Error(
      "createPostgresRetrievalEngineForTesting requires a valid fake RetrievalSqlClient with a begin(callback) method."
    );
  }
  if ("role" in sql && (sql as { role?: unknown }).role !== "brain_app") {
    throw new Error(
      `createPostgresRetrievalEngineForTesting rejects non-brain_app role '${String((sql as { role?: unknown }).role)}'.`
    );
  }
  const seamTarget: UnsafeTestSeamTarget<TTx> = {
    [UNSAFE_RAW_SQL_TEST_SEAM]: true,
    sql
  };
  return new PostgresRetrievalEngine(
    seamTarget as unknown as AppPostgresClient<TTx>,
    maybeGraph,
    maybeOptions
  );
}
