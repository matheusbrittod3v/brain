import type { AuthContext } from "@brain/auth";
import {
  resolveRlsSessionContext,
  type AppPostgresClient,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export type RelationType =
  | "IMPLEMENTS"
  | "GOVERNED_BY"
  | "DEPENDS_ON"
  | "DECIDED_BY"
  | "VERIFIED_BY"
  | "BLOCKED_BY"
  | "SUPERSEDES"
  | "IMPACTS"
  | "CONSUMES_API"
  | "PUBLISHES_EVENT"
  | "SUBSCRIBES_TO"
  | "CO_ACCESSED_WITH";

export const RELATION_TYPES: readonly RelationType[] = [
  "IMPLEMENTS",
  "GOVERNED_BY",
  "DEPENDS_ON",
  "DECIDED_BY",
  "VERIFIED_BY",
  "BLOCKED_BY",
  "SUPERSEDES",
  "IMPACTS",
  "CONSUMES_API",
  "PUBLISHES_EVENT",
  "SUBSCRIBES_TO",
  "CO_ACCESSED_WITH"
];

const VALID_RELATION_TYPES = new Set<RelationType>(RELATION_TYPES);
const INVALID_SCOPE_TOKEN_CHARS = /[,\0\r\n]/;

export interface GraphEdge {
  tenantId: string;
  fromProjectId: string;
  toProjectId: string;
  fromItemId: string;
  toItemId: string;
  fromPolicyId: string;
  toPolicyId: string;
  relationType: RelationType;
  isInferred: boolean;
  confidence: number;
  evidenceUri?: string;
  metadata?: Record<string, unknown>;
}

export interface TraversalHit {
  itemId: string;
  projectId: string;
  hops: number;
  via: RelationType;
  isInferred: boolean;
}

export interface TraversalOrigin {
  projectId: string;
  itemId: string;
}

export interface GraphTraversalRow {
  root_project_id?: string;
  project_id: string;
  item_id: string;
  hops: number | string;
  via: RelationType;
  is_inferred: boolean;
}

export type GraphSqlTransactionRunner = {
  (template: TemplateStringsArray, ...parameters: readonly unknown[]): PromiseLike<unknown>;
};

export type GraphSqlClient<TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner> =
  RlsSqlClient<TTx>;

export type GraphPostgresTarget<TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner> =
  AppPostgresClient<TTx>;

export type PostgresGraphStoreOptions<
  TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner
> =
  | {
      client: AppPostgresClient<TTx>;
      context?: RlsSessionContext;
    }
  | {
      sql: AppPostgresClient<TTx>;
      context?: RlsSessionContext;
    };

export const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("brain.graph.unsafeRawSqlTestSeam");

export interface UnsafeGraphTestSeamTarget<TTx extends GraphSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: GraphSqlClient<TTx>;
}

export function isUnsafeGraphTestSeamTarget<TTx extends GraphSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeGraphTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

export function assertVerifiedAppPostgresClient<TTx extends GraphSqlTransactionRunner>(
  candidate: unknown
): AppPostgresClient<TTx> {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      "PostgresGraphStore requires a verified AppPostgresClient bound to role 'brain_app'; raw RlsSqlClient is forbidden on the production path."
    );
  }
  const obj = candidate as Partial<AppPostgresClient<TTx>> & { begin?: unknown };
  if (obj.role !== "brain_app") {
    const receivedRole = "role" in obj ? `'${String(obj.role)}'` : "unverified raw SQL client";
    throw new Error(
      `PostgresGraphStore requires a verified AppPostgresClient bound to role 'brain_app' (received ${receivedRole}); raw RlsSqlClient is forbidden on the production path.`
    );
  }
  if (
    typeof obj.withRlsTransaction !== "function" ||
    typeof obj.close !== "function" ||
    (obj.sql !== undefined && (!obj.sql || typeof obj.sql.begin !== "function"))
  ) {
    throw new Error(
      "PostgresGraphStore requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql.begin."
    );
  }
  return obj as AppPostgresClient<TTx>;
}

export interface GraphStoreContract {
  addEdge(edge: GraphEdge, ctx?: AuthContext | RlsSessionContext): void | Promise<void>;
  traverseRelated(
    ctx: AuthContext,
    start: string | TraversalOrigin,
    maxDepth?: number
  ): TraversalHit[] | Promise<TraversalHit[]>;
}

export interface AsyncGraphStore extends GraphStoreContract {
  addEdge(edge: GraphEdge, ctx?: AuthContext | RlsSessionContext): Promise<void>;
  traverseRelated(
    ctx: AuthContext,
    start: string | TraversalOrigin,
    maxDepth?: number
  ): Promise<TraversalHit[]>;
}

export function requireGraphToken(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (INVALID_SCOPE_TOKEN_CHARS.test(raw)) {
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

export function encodeGraphNodeKey(projectId: string, itemId: string): string {
  return JSON.stringify([projectId, itemId]);
}

export function validateGraphEdgeInput(edge: GraphEdge): GraphEdge {
  if (!edge || typeof edge !== "object") {
    throw new Error("GraphEdge must be a non-null object.");
  }

  const tenantId = requireGraphToken(edge.tenantId, "GraphEdge.tenantId");
  const fromProjectId = requireGraphToken(edge.fromProjectId, "GraphEdge.fromProjectId");
  const toProjectId = requireGraphToken(edge.toProjectId, "GraphEdge.toProjectId");
  const fromItemId = requireGraphToken(edge.fromItemId, "GraphEdge.fromItemId");
  const toItemId = requireGraphToken(edge.toItemId, "GraphEdge.toItemId");
  const fromPolicyId = requireGraphToken(edge.fromPolicyId, "GraphEdge.fromPolicyId");
  const toPolicyId = requireGraphToken(edge.toPolicyId, "GraphEdge.toPolicyId");

  if (!VALID_RELATION_TYPES.has(edge.relationType)) {
    throw new Error(`GraphEdge.relationType must be a valid RelationType.`);
  }
  if (typeof edge.isInferred !== "boolean") {
    throw new Error("GraphEdge.isInferred must be a boolean.");
  }
  if (typeof edge.confidence !== "number" || !Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
    throw new Error("GraphEdge.confidence must be a finite number between 0 and 1.");
  }
  if (edge.evidenceUri !== undefined && (typeof edge.evidenceUri !== "string" || edge.evidenceUri.length > 2048 || /[\0\r\n]/.test(edge.evidenceUri))) {
    throw new Error("GraphEdge.evidenceUri must be a visible string up to 2048 characters.");
  }
  if (edge.metadata !== undefined && (!edge.metadata || typeof edge.metadata !== "object" || Array.isArray(edge.metadata))) {
    throw new Error("GraphEdge.metadata must be an object.");
  }
  if (edge.metadata !== undefined) JSON.stringify(edge.metadata);

  return {
    tenantId,
    fromProjectId,
    toProjectId,
    fromItemId,
    toItemId,
    fromPolicyId,
    toPolicyId,
    relationType: edge.relationType,
    isInferred: edge.isInferred,
    confidence: edge.confidence,
    ...(edge.evidenceUri !== undefined ? { evidenceUri: edge.evidenceUri } : {}),
    ...(edge.metadata !== undefined ? { metadata: edge.metadata } : {})
  };
}

export function validateGraphEdgeForRlsContext(
  edge: GraphEdge,
  context: RlsSessionContext
): GraphEdge {
  const resolved = resolveRlsSessionContext(context);
  const validated = validateGraphEdgeInput(edge);

  if (validated.tenantId !== resolved.tenantId) {
    throw new Error(
      `GraphEdge.tenantId '${validated.tenantId}' does not match RLS context tenantId '${resolved.tenantId}'.`
    );
  }

  const allowedProjects = new Set(resolved.allowedProjectsCsv.split(","));
  if (!allowedProjects.has(validated.fromProjectId)) {
    throw new Error(
      `GraphEdge.fromProjectId '${validated.fromProjectId}' is not authorized in RLS context allowedProjects.`
    );
  }
  if (!allowedProjects.has(validated.toProjectId)) {
    throw new Error(
      `GraphEdge.toProjectId '${validated.toProjectId}' is not authorized in RLS context allowedProjects.`
    );
  }

  const allowedPolicies = new Set(resolved.allowedPoliciesCsv.split(","));
  if (!allowedPolicies.has(validated.fromPolicyId)) {
    throw new Error(
      `GraphEdge.fromPolicyId '${validated.fromPolicyId}' is not authorized in RLS context allowedPolicies.`
    );
  }
  if (!allowedPolicies.has(validated.toPolicyId)) {
    throw new Error(
      `GraphEdge.toPolicyId '${validated.toPolicyId}' is not authorized in RLS context allowedPolicies.`
    );
  }

  return validated;
}

