import { createHash } from "node:crypto";
import type { AuthContext } from "@brain/auth";
import type { KnowledgeItem, KnowledgeStatus, KnowledgeType, TrustLevel } from "@brain/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";
import type { GraphStoreContract, RelationType, TraversalHit } from "@brain/graph";
import type { SearchExplain, SearchHit, SearchQuery } from "./index.js";

export type { RlsSessionContext } from "@brain/database";

export interface SqlSearchQuery extends SearchQuery {
  queryEmbedding?: readonly number[];
  embeddingModel?: string;
}

export interface SqlSearchExplain extends SearchExplain {
  vectorScore?: number;
  rrfScore?: number;
}

export interface SqlSearchHit extends SearchHit {
  explain?: SqlSearchExplain;
}

export type RetrievalSqlParameter = string | number | boolean | null | readonly string[];

export type RetrievalSqlTransactionRunner = {
  <TRow = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly RetrievalSqlParameter[]
  ): PromiseLike<readonly TRow[]>;
};

export type RetrievalSqlClient<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
> = RlsSqlClient<TTx>;

export type RetrievalPostgresTarget<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
> = AppPostgresClient<TTx>;

export interface RetrievalCacheBackend {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del?(...keys: string[]): Promise<number | void>;
  invalidateByPrefix?(prefix: string): Promise<void>;
}

export type PostgresRetrievalEngineOptions<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
> =
  | {
      client: AppPostgresClient<TTx>;
      graph?: GraphStoreContract;
      now?: () => Date;
      cache?: RetrievalCacheBackend;
      cacheTtlMs?: number;
      cacheMaxEntries?: number;
      rerankUrl?: string;
    }
  | {
      sql: AppPostgresClient<TTx>;
      graph?: GraphStoreContract;
      now?: () => Date;
      cache?: RetrievalCacheBackend;
      cacheTtlMs?: number;
      cacheMaxEntries?: number;
      rerankUrl?: string;
    };

const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("brain.retrieval.unsafeRawSqlTestSeam");

interface UnsafeTestSeamTarget<TTx extends RetrievalSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: RetrievalSqlClient<TTx>;
}

function isUnsafeTestSeamTarget<TTx extends RetrievalSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

function assertVerifiedAppPostgresClient<TTx extends RetrievalSqlTransactionRunner>(
  candidate: unknown
): AppPostgresClient<TTx> {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      "PostgresRetrievalEngine requires a verified AppPostgresClient bound to role 'brain_app'; raw RlsSqlClient is forbidden on the production path."
    );
  }
  const obj = candidate as Partial<AppPostgresClient<TTx>> & { begin?: unknown };
  if (obj.role !== "brain_app") {
    const receivedRole = "role" in obj ? `'${String(obj.role)}'` : "unverified raw SQL client";
    throw new Error(
      `PostgresRetrievalEngine requires a verified AppPostgresClient bound to role 'brain_app' (received ${receivedRole}); raw RlsSqlClient is forbidden on the production path.`
    );
  }
  if (
    typeof obj.withRlsTransaction !== "function" ||
    typeof obj.close !== "function" ||
    (obj.sql !== undefined && (!obj.sql || typeof obj.sql.begin !== "function"))
  ) {
    throw new Error(
      "PostgresRetrievalEngine requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql.begin."
    );
  }
  return obj as AppPostgresClient<TTx>;
}

export interface AsyncRetrievalEngine {
  getItem(ctx: AuthContext, projectId: string, id: string): Promise<KnowledgeItem | undefined>;
  search(ctx: AuthContext, query: SqlSearchQuery): Promise<SqlSearchHit[]>;
  recordHitBoost(projectId: string, itemId: string, delta?: number): void;
  invalidateCache?(tenantId: string, projectId?: string): void;
}

export interface RetrievalKnowledgeItemRow {
  id: string;
  tenant_id: string;
  project_id: string;
  domain_id: number;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  status: string;
  source_id: string;
  source_origin: string;
  source_kind: string;
  source_version: string;
  source_uri: string;
  version: number;
  content_hash: string;
  owner_id: string | null;
  confidence: number;
  trust_level: string;
  is_inferred: boolean;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  tags: string[] | string;
  access_policy_id: string;
  hit_count?: number | string;
  context_sent_count?: number | string;
  context_hit_count?: number | string;
  metadata: Record<string, unknown> | string;
  deleted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  lexical_rank?: number | string | null;
}

export interface RetrievalVectorRankRow {
  project_id: string;
  knowledge_item_id: string;
  vector_similarity: number | string;
}

export interface RetrievalGraphWalkRow {
  root_project_id: string;
  project_id: string;
  item_id: string;
  hops: number | string;
  via: RelationType;
  is_inferred: boolean;
}

const INVALID_TOKEN_CHARS = /[,\0\r\n]/;
const EXPECTED_VECTOR_DIMENSIONS = 1024;
const RRF_K = 60;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface LruCacheEntry {
  tenantId: string;
  projectId: string;
  value: SqlSearchHit[];
  expiresAtMs: number;
}

class LruQueryCache {
  private readonly store = new Map<string, LruCacheEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => Date
  ) {}

  get(key: string): SqlSearchHit[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now().getTime() >= entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }
    // Move to most-recently-used position
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, tenantId: string, projectId: string, value: SqlSearchHit[]): void {
    if (this.maxEntries <= 0 || this.ttlMs <= 0) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      tenantId,
      projectId,
      value,
      expiresAtMs: this.now().getTime() + this.ttlMs
    });
  }

  invalidate(tenantId: string, projectId?: string): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.tenantId !== tenantId) continue;
      if (projectId !== undefined && entry.projectId !== projectId) continue;
      this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

function computePolicyHash(allowedProjects: Set<string>, allowedPolicies: Set<string>): string {
  const payload = JSON.stringify({
    projects: [...allowedProjects].sort(),
    policies: [...allowedPolicies].sort()
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function parseAtDate(atDate: string | undefined): { iso: string; ms: number } | undefined {
  if (atDate === undefined) return undefined;
  const ms = Date.parse(atDate);
  if (Number.isNaN(ms)) {
    throw new Error("SearchQuery.atDate must be a valid ISO-8601 date string.");
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function compositeItemKey(projectId: string, itemId: string): string {
  return JSON.stringify([projectId, itemId]);
}

function requireToken(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (INVALID_TOKEN_CHARS.test(raw)) {
    throw new Error(`${fieldName} contains invalid characters (comma, null byte, or newline).`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (trimmed === "*") {
    throw new Error(`${fieldName} cannot be wildcard '*'; an explicit identifier is required.`);
  }
  return trimmed;
}

function validateDomainFilter(domains: readonly number[] | undefined): string {
  if (!domains || domains.length === 0) return "";
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 12) {
      throw new Error(`domains[${i}] must be an integer domain ID between 1 and 12.`);
    }
    if (!seen.has(d)) {
      seen.add(d);
      normalized.push(d);
    }
  }
  return normalized.join(",");
}

function validateQueryEmbedding(embedding: readonly number[] | undefined): string | undefined {
  if (embedding === undefined) return undefined;
  if (!Array.isArray(embedding) || embedding.length !== EXPECTED_VECTOR_DIMENSIONS) {
    throw new Error(`queryEmbedding must be a finite number array of exactly ${EXPECTED_VECTOR_DIMENSIONS} dimensions.`);
  }
  const formatted: string[] = [];
  for (let i = 0; i < embedding.length; i++) {
    const val = embedding[i];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new Error(`queryEmbedding[${i}] must be a finite number.`);
    }
    formatted.push(String(val));
  }
  return `[${formatted.join(",")}]`;
}

function parseIsoOrString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function parseOptionalIso(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  return parseIsoOrString(val);
}

function parseTagsArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string" && val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.replace(/^"(.*)"$/, "$1"));
  }
  return [];
}

function parseMetadataObject(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof val === "object" && !Array.isArray(val)) {
    return { ...(val as Record<string, unknown>) };
  }
  return {};
}

function mapRowToKnowledgeItem(row: RetrievalKnowledgeItemRow): KnowledgeItem {
  const metadata = parseMetadataObject(row.metadata);
  const relatedIds = Array.isArray(metadata.relatedIds) ? metadata.relatedIds.map(String) : [];
  const summary = row.summary !== null && row.summary !== undefined ? String(row.summary) : undefined;
  const ownerId = row.owner_id !== null && row.owner_id !== undefined ? String(row.owner_id) : undefined;
  const validFrom = parseOptionalIso(row.valid_from);
  const validUntil = parseOptionalIso(row.valid_until);
  const deletedAt = parseOptionalIso(row.deleted_at);

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    domainId: Number(row.domain_id),
    type: row.type as KnowledgeType,
    title: String(row.title),
    content: String(row.content),
    ...(summary !== undefined ? { summary } : {}),
    status: row.status as KnowledgeStatus,
    sourceId: String(row.source_id),
    sourceOrigin: row.source_origin as KnowledgeItem["sourceOrigin"],
    sourceKind: row.source_kind as KnowledgeItem["sourceKind"],
    sourceVersion: String(row.source_version),
    sourceUri: String(row.source_uri),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    ...(ownerId !== undefined ? { ownerId } : {}),
    confidence: Number(row.confidence),
    trustLevel: row.trust_level as TrustLevel,
    isInferred: Boolean(row.is_inferred),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    tags: parseTagsArray(row.tags),
    relatedIds,
    accessPolicyId: String(row.access_policy_id),
    metadata,
    ...(deletedAt !== undefined ? { deletedAt } : {}),
    createdAt: parseIsoOrString(row.created_at),
    updatedAt: parseIsoOrString(row.updated_at)
  };
}

function computeLexicalFallbackScore(item: KnowledgeItem, terms: readonly string[]): number {
  if (terms.length === 0) return 0.1;
  const hay = `${item.id} ${item.title} ${item.summary ?? ""} ${item.content} ${item.tags.join(" ")}`.toLowerCase();
  let matches = 0;
  for (const t of terms) {
    if (hay.includes(t)) matches += 1;
  }
  return matches / terms.length;
}

/**
 * Asynchronous PostgreSQL-backed Hybrid Retrieval Engine (`SqlRetrievalEngine`).
 *
 * - Preserves `HybridRetrievalEngine` synchronous in-memory adapter intact.
 * - Enforces fail-closed pre-transaction checks for `tenantId`, `allowedProjects`, `allowedPolicies`,
 *   and `projectId` authorization before calling `sql.begin(...)`.
 * - Includes `"__org__"` items only when `"__org__"` is explicitly present in `ctx.allowedProjects`.
 * - Executes inside `AppPostgresClient.withRlsTransaction` / `withRlsTransaction`:
 *   1. Lexical FTS over `knowledge_items.search_vector` (`ts_rank_cd` + `websearch_to_tsquery('simple', ...)`),
 *      filtering `deleted_at IS NULL`, `status NOT IN ('deprecated', 'superseded')`, `(valid_until IS NULL OR valid_until > NOW())`,
 *      and optional `domain_id`.
 *   2. Exact vector similarity (`1 - (embedding <=> $vector::vector)`) over `knowledge_embeddings` restricted to the
 *      authorized subset (no HNSW index, per Normative Decisions 25–26).
 *   3. Bidirectional graph expansion from top seeds using composite `{ projectId, itemId }` origins and composite keys.
 *   4. Normative scoring formula (`0.45 * relevance + 0.25 * graphProximity + 0.15 * authorityWeight + 0.10 * recencyDecay + 0.05 * hitRateBoost`)
 *      with deterministic tie-breaking (`status === 'approved'`, `isInferred === false`).
 */
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
      // 1. Authorized candidate & lexical FTS query over search_vector
      const candidateRows = await tx<RetrievalKnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, hit_count, context_sent_count, context_hit_count, metadata, deleted_at, created_at, updated_at,
        CASE
          WHEN ${normalizedQuery} = '' THEN 0.1
          WHEN search_vector @@ websearch_to_tsquery('simple', ${normalizedQuery})
            THEN ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${normalizedQuery}))
          ELSE 0
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

      // Normalize lexical scores into [0..1]
      const maxLexical = Math.max(0, ...rawLexicalRanks.values());
      const lexicalScores = new Map<string, number>();
      for (const item of candidates) {
        const key = compositeItemKey(item.projectId, item.id);
        const raw = rawLexicalRanks.get(key) ?? 0;
        const normalized = maxLexical > 1 ? raw / maxLexical : Math.min(1, raw);
        lexicalScores.set(key, normalized);
      }

      // 2. Optional exact vector scan over authorized subset (Normative Decisions 25-26: no HNSW)
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

      // Compute RRF / hybrid relevance score in [0..1]
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
          const combined = normalizedRrf;
          relevanceScores.set(key, { lex, vec, rrf: normalizedRrf, combined });
        }
      } else {
        for (const item of candidates) {
          const key = compositeItemKey(item.projectId, item.id);
          const lex = lexicalScores.get(key) ?? 0;
          relevanceScores.set(key, { lex, vec: 0, rrf: lex, combined: lex });
        }
      }

      // 3. Graph expansion from top 3 seeds using composite { projectId, itemId } origins
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
          traversalHits = await this.traverseGraphInTransaction(
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

      // 4. Normative scoring & tie-breaking
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

  private async traverseGraphInTransaction(
    tx: TTx,
    resolved: ResolvedRlsSessionGucs,
    allowedProjects: Set<string>,
    seedProjectId: string,
    seedItemId: string,
    maxDepth: number
  ): Promise<TraversalHit[]> {
    const rows = await tx<RetrievalGraphWalkRow>`WITH RECURSIVE params AS (
      SELECT
        ${resolved.tenantId} AS tenant_id,
        ${seedProjectId} AS origin_project,
        ${seedItemId} AS origin_item,
        string_to_array(${resolved.allowedProjectsCsv}, ',') AS allowed_projects,
        string_to_array(${resolved.allowedPoliciesCsv}, ',') AS allowed_policies,
        ${maxDepth}::integer AS max_depth
    ),
    graph_walk AS (
      SELECT
        p.origin_project AS root_project_id,
        CASE
          WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
            THEN kr.to_project_id
          ELSE kr.from_project_id
        END AS project_id,
        CASE
          WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
            THEN kr.to_item_id
          ELSE kr.from_item_id
        END AS item_id,
        1 AS hops,
        kr.relation_type AS via,
        kr.is_inferred AS is_inferred,
        ARRAY[
          jsonb_build_array(p.origin_project, p.origin_item)::text,
          jsonb_build_array(
            CASE
              WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
                THEN kr.to_project_id
              ELSE kr.from_project_id
            END,
            CASE
              WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
                THEN kr.to_item_id
              ELSE kr.from_item_id
            END
          )::text
        ] AS visited_path
      FROM knowledge_relations kr
      CROSS JOIN params p
      WHERE kr.tenant_id = p.tenant_id
        AND kr.from_project_id = ANY(p.allowed_projects)
        AND kr.to_project_id = ANY(p.allowed_projects)
        AND kr.from_policy_id = ANY(p.allowed_policies)
        AND kr.to_policy_id = ANY(p.allowed_policies)
        AND (
          (kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item)
          OR
          (kr.to_project_id = p.origin_project AND kr.to_item_id = p.origin_item)
        )

      UNION ALL

      SELECT
        gw.root_project_id AS root_project_id,
        CASE
          WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
            THEN kr.to_project_id
          ELSE kr.from_project_id
        END AS project_id,
        CASE
          WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
            THEN kr.to_item_id
          ELSE kr.from_item_id
        END AS item_id,
        gw.hops + 1 AS hops,
        kr.relation_type AS via,
        kr.is_inferred AS is_inferred,
        gw.visited_path || jsonb_build_array(
          CASE
            WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
              THEN kr.to_project_id
            ELSE kr.from_project_id
          END,
          CASE
            WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
              THEN kr.to_item_id
            ELSE kr.from_item_id
          END
        )::text
      FROM graph_walk gw
      CROSS JOIN params p
      JOIN knowledge_relations kr
        ON kr.tenant_id = p.tenant_id
       AND (
         (kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id)
         OR
         (kr.to_project_id = gw.project_id AND kr.to_item_id = gw.item_id)
       )
      WHERE gw.hops < p.max_depth
        AND kr.from_project_id = ANY(p.allowed_projects)
        AND kr.to_project_id = ANY(p.allowed_projects)
        AND kr.from_policy_id = ANY(p.allowed_policies)
        AND kr.to_policy_id = ANY(p.allowed_policies)
        AND NOT (
          jsonb_build_array(
            CASE
              WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
                THEN kr.to_project_id
              ELSE kr.from_project_id
            END,
            CASE
              WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
                THEN kr.to_item_id
              ELSE kr.from_item_id
            END
          )::text = ANY(gw.visited_path)
        )
    )
    SELECT
      root_project_id,
      project_id,
      item_id,
      hops,
      via,
      is_inferred
    FROM graph_walk
    ORDER BY hops ASC`;

    const seen = new Set<string>([compositeItemKey(seedProjectId, seedItemId)]);
    const hits: TraversalHit[] = [];
    for (const row of rows) {
      const projId = String(row.project_id);
      const itemId = String(row.item_id);
      const hops = Number(row.hops);
      if (!allowedProjects.has(projId)) continue;
      if (!Number.isInteger(hops) || hops < 1 || hops > maxDepth) continue;
      const key = compositeItemKey(projId, itemId);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        itemId,
        projectId: projId,
        hops,
        via: row.via,
        isInferred: Boolean(row.is_inferred)
      });
    }
    return hits;
  }
}

export { PostgresRetrievalEngine as SqlRetrievalEngine };

export function createPostgresRetrievalEngine<
  TTx extends RetrievalSqlTransactionRunner = RetrievalSqlTransactionRunner
>(
  clientOrOptions: RetrievalPostgresTarget<TTx> | PostgresRetrievalEngineOptions<TTx>,
  maybeGraph?: GraphStoreContract,
  maybeOptions?: { now?: () => Date }
): PostgresRetrievalEngine<TTx> {
  return new PostgresRetrievalEngine(clientOrOptions, maybeGraph, maybeOptions);
}

/**
 * Explicit test-only factory that allows injecting a fake `RetrievalSqlClient` (`{ begin }`)
 * in offline behavioral unit tests without a full `AppPostgresClient`.
 *
 * Production code MUST use `new PostgresRetrievalEngine(appClient, ...)` or
 * `createPostgresRetrievalEngine(appClient, ...)` with a verified `brain_app` client.
 */
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
