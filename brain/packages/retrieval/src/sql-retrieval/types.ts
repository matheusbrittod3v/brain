import type { AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import type { AppPostgresClient, RlsSessionContext, RlsSqlClient } from "@brain/database";
import type { GraphStoreContract, RelationType } from "@brain/graph";
import type { SearchExplain, SearchHit, SearchQuery } from "../index.js";

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

export const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("brain.retrieval.unsafeRawSqlTestSeam");

export interface UnsafeTestSeamTarget<TTx extends RetrievalSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: RetrievalSqlClient<TTx>;
}

export function isUnsafeTestSeamTarget<TTx extends RetrievalSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

export function assertVerifiedAppPostgresClient<TTx extends RetrievalSqlTransactionRunner>(
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

