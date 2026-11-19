export type {
  KnowledgeEmbeddingChunkInput,
  KnowledgeItemVersion,
  KnowledgePostgresTarget,
  KnowledgeRepository,
  KnowledgeSqlClient,
  KnowledgeSqlParameter,
  KnowledgeSqlTransactionRunner,
  PostgresKnowledgeRepositoryOptions,
  ReplaceItemEmbeddingsInput,
  RlsSessionContext,
  UpsertKnowledgeResult
} from "./repository/types.js";

export {
  validateKnowledgeItemForRlsContext,
  validateReplaceItemEmbeddingsInput,
  type KnowledgeItemRow,
  type KnowledgeItemVersionRow,
  type ValidatedReplaceEmbeddings
} from "./repository/validators.js";

export { InMemoryKnowledgeRepository } from "./repository/memory-repo.js";

export {
  PostgresKnowledgeRepository,
  PostgresKnowledgeRepository as SqlKnowledgeRepository,
  createPostgresKnowledgeRepository
} from "./repository/postgres-repo.js";

export {
  privacyEraseSubject,
  type PrivacyEraseSubjectInput,
  type PrivacyEraseSubjectResult,
  type SystemKnowledgeSqlClient
} from "./repository/privacy.js";
