export {
  createAppPostgresClient,
  getAppDatabaseUrl,
  type AppPostgresClient,
  type AppPostgresClientOptions,
  type AppPostgresPoolOptions,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export {
  RELATION_TYPES,
  encodeGraphNodeKey,
  validateGraphEdgeForRlsContext,
  validateGraphEdgeInput,
  type AsyncGraphStore,
  type GraphEdge,
  type GraphPostgresTarget,
  type GraphSqlClient,
  type GraphSqlTransactionRunner,
  type GraphStoreContract,
  type GraphTraversalRow,
  type PostgresGraphStoreOptions,
  type RelationType,
  type TraversalHit,
  type TraversalOrigin
} from "./types.js";

export { KnowledgeGraphStore } from "./memory-store.js";
export {
  PostgresGraphStore,
  createPostgresGraphStore,
  createPostgresGraphStoreForTesting
} from "./postgres-store.js";
