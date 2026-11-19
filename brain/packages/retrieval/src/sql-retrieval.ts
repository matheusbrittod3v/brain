export type {
  AsyncRetrievalEngine,
  PostgresRetrievalEngineOptions,
  RetrievalCacheBackend,
  RetrievalGraphWalkRow,
  RetrievalKnowledgeItemRow,
  RetrievalPostgresTarget,
  RetrievalSqlClient,
  RetrievalSqlParameter,
  RetrievalSqlTransactionRunner,
  RetrievalVectorRankRow,
  RlsSessionContext,
  SqlSearchExplain,
  SqlSearchHit,
  SqlSearchQuery
} from "./sql-retrieval/types.js";

export {
  PostgresRetrievalEngine,
  PostgresRetrievalEngine as SqlRetrievalEngine,
  createPostgresRetrievalEngine,
  createPostgresRetrievalEngineForTesting
} from "./sql-retrieval/engine.js";
