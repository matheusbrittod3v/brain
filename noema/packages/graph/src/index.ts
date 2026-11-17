import type { AuthContext } from "@noema/auth";
import {
  createAppPostgresClient,
  getAppDatabaseUrl,
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type AppPostgresClientOptions,
  type AppPostgresPoolOptions,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient
} from "@noema/database";

export {
  createAppPostgresClient,
  getAppDatabaseUrl,
  type AppPostgresClient,
  type AppPostgresClientOptions,
  type AppPostgresPoolOptions,
  type RlsSessionContext,
  type RlsSqlClient
} from "@noema/database";

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
  (template: TemplateStringsArray, ...parameters: readonly string[]): PromiseLike<unknown>;
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

const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("noema.graph.unsafeRawSqlTestSeam");

interface UnsafeGraphTestSeamTarget<TTx extends GraphSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: GraphSqlClient<TTx>;
}

function isUnsafeGraphTestSeamTarget<TTx extends GraphSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeGraphTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

function assertVerifiedAppPostgresClient<TTx extends GraphSqlTransactionRunner>(
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

function requireGraphToken(raw: unknown, fieldName: string): string {
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

/**
 * Encodes a `(projectId, itemId)` composite node identity as a canonical JSON 2-tuple string.
 * Bijective for all valid tokens (including tokens containing `:` or other punctuation),
 * matching PostgreSQL `jsonb_build_array(project_id, item_id)::text` semantics.
 */
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
    confidence: edge.confidence
  };
}

/**
 * Validates a `GraphEdge` against a trusted `RlsSessionContext` before opening a database transaction.
 * Enforces matching `tenantId`, both `fromProjectId` and `toProjectId` in `allowedProjects`
 * (including explicit `"__org__"` when organizational), and both `fromPolicyId` and `toPolicyId`
 * in `allowedPolicies`.
 */
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

export class KnowledgeGraphStore implements GraphStoreContract {
  private readonly edges: GraphEdge[] = [];

  addEdge(edge: GraphEdge): void {
    const exists = this.edges.some(
      (e) =>
        e.tenantId === edge.tenantId &&
        e.fromProjectId === edge.fromProjectId &&
        e.toProjectId === edge.toProjectId &&
        e.fromItemId === edge.fromItemId &&
        e.toItemId === edge.toItemId &&
        e.relationType === edge.relationType
    );
    if (!exists) this.edges.push(edge);
  }

  /**
   * Travessia BFS segura: valida tenantId, allowedProjects e allowedPolicies nos DOIS extremos da aresta.
   * Suporta origem qualificada por projeto (`{ projectId, itemId }`) para evitar colisão de IDs entre projetos,
   * mantendo compatibilidade retroativa com `startItemId: string` quando não ambíguo entre projetos autorizados.
   */
  traverseRelated(ctx: AuthContext, start: string | TraversalOrigin, maxDepth = 2): TraversalHit[] {
    if (maxDepth <= 0) {
      return [];
    }

    const allowedProjects = new Set(ctx.allowedProjects);
    const allowedPolicies = new Set(ctx.allowedPolicies);
    if (allowedProjects.size === 0 || allowedPolicies.size === 0) {
      return [];
    }

    const startItemId = typeof start === "string" ? start : start.itemId;
    let resolvedStartProjectId = typeof start === "string" ? undefined : start.projectId;

    if (resolvedStartProjectId !== undefined && !allowedProjects.has(resolvedStartProjectId)) {
      return [];
    }

    if (resolvedStartProjectId === undefined) {
      const matchingOriginProjects = new Set<string>();
      for (const edge of this.edges) {
        if (edge.tenantId !== ctx.tenantId) continue;
        if (!allowedProjects.has(edge.fromProjectId) || !allowedProjects.has(edge.toProjectId)) continue;
        if (!allowedPolicies.has(edge.fromPolicyId) || !allowedPolicies.has(edge.toPolicyId)) continue;
        if (edge.fromItemId === startItemId) {
          matchingOriginProjects.add(edge.fromProjectId);
        }
        if (edge.toItemId === startItemId) {
          matchingOriginProjects.add(edge.toProjectId);
        }
      }

      if (matchingOriginProjects.size === 0) {
        return [];
      }
      if (matchingOriginProjects.size > 1) {
        throw new Error(
          `Ambiguous homonymous start itemId '${startItemId}' across multiple authorized projects; pass TraversalOrigin { projectId, itemId }.`
        );
      }
      resolvedStartProjectId = [...matchingOriginProjects][0]!;
    }

    const visited = new Set<string>([encodeGraphNodeKey(resolvedStartProjectId, startItemId)]);
    const queue: Array<{ projectId: string; id: string; depth: number }> = [
      { projectId: resolvedStartProjectId, id: startItemId, depth: 0 }
    ];
    const hits: TraversalHit[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      for (const edge of this.edges) {
        if (edge.tenantId !== ctx.tenantId) continue;
        if (!allowedProjects.has(edge.fromProjectId) || !allowedProjects.has(edge.toProjectId)) continue;
        if (!allowedPolicies.has(edge.fromPolicyId) || !allowedPolicies.has(edge.toPolicyId)) continue;

        let neighborId: string | null = null;
        let neighborProject = "";

        const matchesFrom =
          edge.fromItemId === current.id && edge.fromProjectId === current.projectId;
        const matchesTo =
          edge.toItemId === current.id && edge.toProjectId === current.projectId;

        if (matchesFrom) {
          neighborId = edge.toItemId;
          neighborProject = edge.toProjectId;
        } else if (matchesTo) {
          neighborId = edge.fromItemId;
          neighborProject = edge.fromProjectId;
        }

        if (neighborId) {
          const visitKey = encodeGraphNodeKey(neighborProject, neighborId);
          if (!visited.has(visitKey)) {
            visited.add(visitKey);
            hits.push({
              itemId: neighborId,
              projectId: neighborProject,
              hops: current.depth + 1,
              via: edge.relationType,
              isInferred: edge.isInferred
            });
            queue.push({ projectId: neighborProject, id: neighborId, depth: current.depth + 1 });
          }
        }
      }
    }

    return hits;
  }
}

function isGraphEdge(candidate: unknown): candidate is GraphEdge {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    "fromProjectId" in (candidate as Record<string, unknown>) &&
    "toProjectId" in (candidate as Record<string, unknown>) &&
    "fromItemId" in (candidate as Record<string, unknown>) &&
    "toItemId" in (candidate as Record<string, unknown>)
  );
}

/**
 * PostgreSQL-backed Knowledge Graph store (`knowledge_relations`) using
 * `AppPostgresClient.withRlsTransaction` / `withRlsTransaction`.
 *
 * - `addEdge` is idempotent via `ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO NOTHING`.
 * - `traverseRelated` runs a parameterized bidirectional recursive CTE (`WITH RECURSIVE graph_walk`)
 *   enforcing `tenant_id`, `allowedProjects` on both endpoints, `allowedPolicies` on both endpoints,
 *   explicit `"__org__"` authorization, and composite `(project_id, item_id)` hop keys without
 *   ambiguously expanding homonymous IDs across projects.
 */
export class PostgresGraphStore<
  TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner
> implements AsyncGraphStore {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly defaultContext?: RlsSessionContext;
  private readonly resolvedDefaultContext?: ResolvedRlsSessionGucs;

  constructor(
    client: AppPostgresClient<TTx>,
    defaultContext?: RlsSessionContext
  );
  constructor(options: PostgresGraphStoreOptions<TTx>);
  constructor(
    clientOrOptions: AppPostgresClient<TTx> | PostgresGraphStoreOptions<TTx>,
    maybeDefaultContext?: RlsSessionContext
  ) {
    let target: unknown;
    let defaultContext: RlsSessionContext | undefined;

    if (
      clientOrOptions &&
      typeof clientOrOptions === "object" &&
      ("client" in clientOrOptions || "sql" in clientOrOptions) &&
      !("withRlsTransaction" in clientOrOptions) &&
      !("begin" in clientOrOptions) &&
      !isUnsafeGraphTestSeamTarget(clientOrOptions)
    ) {
      target = "client" in clientOrOptions ? clientOrOptions.client : clientOrOptions.sql;
      defaultContext = clientOrOptions.context;
    } else {
      target = clientOrOptions;
      defaultContext = maybeDefaultContext;
    }

    if (isUnsafeGraphTestSeamTarget<TTx>(target)) {
      const sqlClient = target.sql;
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(sqlClient, ctx, cb);
    } else {
      const appClient = assertVerifiedAppPostgresClient<TTx>(target);
      this.runInRlsTransaction = (ctx, cb) => appClient.withRlsTransaction(ctx, cb);
    }

    if (defaultContext !== undefined) {
      this.resolvedDefaultContext = resolveRlsSessionContext(defaultContext);
      this.defaultContext = {
        tenantId: this.resolvedDefaultContext.tenantId,
        allowedProjects: this.resolvedDefaultContext.allowedProjectsCsv.split(","),
        allowedPolicies: this.resolvedDefaultContext.allowedPoliciesCsv.split(",")
      };
    }
  }

  private resolveEffectiveRlsContext(
    callerContext?: AuthContext | RlsSessionContext
  ): { context: RlsSessionContext; resolved: ResolvedRlsSessionGucs } {
    const rawContext = callerContext ?? this.defaultContext;
    if (!rawContext) {
      throw new Error("PostgresGraphStore requires an explicit RlsSessionContext or AuthContext.");
    }

    const resolvedCaller = resolveRlsSessionContext({
      tenantId: rawContext.tenantId,
      allowedProjects: rawContext.allowedProjects,
      allowedPolicies: rawContext.allowedPolicies
    });

    if (this.resolvedDefaultContext) {
      if (resolvedCaller.tenantId !== this.resolvedDefaultContext.tenantId) {
        throw new Error(
          `Context tenantId '${resolvedCaller.tenantId}' does not match store RLS context tenantId '${this.resolvedDefaultContext.tenantId}'.`
        );
      }
      const boundProjects = new Set(this.resolvedDefaultContext.allowedProjectsCsv.split(","));
      for (const proj of resolvedCaller.allowedProjectsCsv.split(",")) {
        if (!boundProjects.has(proj)) {
          throw new Error(
            `Project '${proj}' is not authorized in the store's bound RLS context allowedProjects.`
          );
        }
      }
      const boundPolicies = new Set(this.resolvedDefaultContext.allowedPoliciesCsv.split(","));
      for (const pol of resolvedCaller.allowedPoliciesCsv.split(",")) {
        if (!boundPolicies.has(pol)) {
          throw new Error(
            `Policy '${pol}' is not authorized in the store's bound RLS context allowedPolicies.`
          );
        }
      }
    }

    return {
      context: {
        tenantId: resolvedCaller.tenantId,
        allowedProjects: resolvedCaller.allowedProjectsCsv.split(","),
        allowedPolicies: resolvedCaller.allowedPoliciesCsv.split(",")
      },
      resolved: resolvedCaller
    };
  }

  async addEdge(edge: GraphEdge, ctx?: AuthContext | RlsSessionContext): Promise<void>;
  async addEdge(ctx: AuthContext | RlsSessionContext, edge: GraphEdge): Promise<void>;
  async addEdge(
    first: GraphEdge | AuthContext | RlsSessionContext,
    second?: GraphEdge | AuthContext | RlsSessionContext
  ): Promise<void> {
    let edge: GraphEdge;
    let callerContext: AuthContext | RlsSessionContext | undefined;

    if (isGraphEdge(first)) {
      edge = first;
      callerContext = second as AuthContext | RlsSessionContext | undefined;
    } else {
      callerContext = first;
      edge = second as GraphEdge;
    }

    const { context } = this.resolveEffectiveRlsContext(callerContext);
    const validated = validateGraphEdgeForRlsContext(edge, context);
    const isInferredParam = validated.isInferred ? "true" : "false";
    const confidenceParam = String(validated.confidence);

    await this.runInRlsTransaction(context, async (tx) => {
      await tx`INSERT INTO knowledge_relations (
        tenant_id,
        from_project_id,
        to_project_id,
        from_item_id,
        to_item_id,
        from_policy_id,
        to_policy_id,
        relation_type,
        is_inferred,
        confidence
      ) VALUES (
        ${validated.tenantId},
        ${validated.fromProjectId},
        ${validated.toProjectId},
        ${validated.fromItemId},
        ${validated.toItemId},
        ${validated.fromPolicyId},
        ${validated.toPolicyId},
        ${validated.relationType},
        ${isInferredParam}::boolean,
        ${confidenceParam}::real
      )
      ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO NOTHING`;
    });
  }

  async traverseRelated(
    ctx: AuthContext,
    start: string | TraversalOrigin,
    maxDepth = 2
  ): Promise<TraversalHit[]> {
    if (!Number.isInteger(maxDepth)) {
      throw new Error("maxDepth must be an integer.");
    }
    if (maxDepth <= 0) {
      return [];
    }
    if (!ctx || typeof ctx !== "object") {
      throw new Error("AuthContext must be a non-null object.");
    }
    if (!Array.isArray(ctx.allowedProjects) || ctx.allowedProjects.length === 0) {
      return [];
    }
    if (!Array.isArray(ctx.allowedPolicies) || ctx.allowedPolicies.length === 0) {
      return [];
    }

    const { context, resolved } = this.resolveEffectiveRlsContext(ctx);
    const allowedProjects = new Set(resolved.allowedProjectsCsv.split(","));

    let originItemId: string;
    let explicitStartProjectId: string | undefined;

    if (typeof start === "string") {
      originItemId = requireGraphToken(start, "start");
    } else if (start && typeof start === "object") {
      explicitStartProjectId = requireGraphToken(start.projectId, "start.projectId");
      originItemId = requireGraphToken(start.itemId, "start.itemId");
      if (!allowedProjects.has(explicitStartProjectId)) {
        return [];
      }
    } else {
      throw new Error("start must be a non-empty itemId string or TraversalOrigin { projectId, itemId }.");
    }

    const originProjectParam = explicitStartProjectId ?? "";
    const maxDepthParam = String(maxDepth);

    return await this.runInRlsTransaction(context, async (tx) => {
      const rawRows = await tx`WITH RECURSIVE params AS (
        SELECT
          ${resolved.tenantId} AS tenant_id,
          ${originProjectParam} AS origin_project,
          ${originItemId} AS origin_item,
          string_to_array(${resolved.allowedProjectsCsv}, ',') AS allowed_projects,
          string_to_array(${resolved.allowedPoliciesCsv}, ',') AS allowed_policies,
          ${maxDepthParam}::integer AS max_depth
      ),
      graph_walk AS (
        SELECT
          CASE
            WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
              THEN kr.from_project_id
            ELSE kr.to_project_id
          END AS root_project_id,
          CASE
            WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
              THEN kr.to_project_id
            ELSE kr.from_project_id
          END AS project_id,
          CASE
            WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
              THEN kr.to_item_id
            ELSE kr.from_item_id
          END AS item_id,
          1 AS hops,
          kr.relation_type AS via,
          kr.is_inferred AS is_inferred,
          ARRAY[
            jsonb_build_array(
              CASE
                WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
                  THEN kr.from_project_id
                ELSE kr.to_project_id
              END,
              p.origin_item
            )::text,
            jsonb_build_array(
              CASE
                WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
                  THEN kr.to_project_id
                ELSE kr.from_project_id
              END,
              CASE
                WHEN kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project)
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
            (kr.from_item_id = p.origin_item AND (p.origin_project = '' OR kr.from_project_id = p.origin_project))
            OR
            (kr.to_item_id = p.origin_item AND (p.origin_project = '' OR kr.to_project_id = p.origin_project))
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

      if (!Array.isArray(rawRows)) {
        return [];
      }

      const rows = rawRows as GraphTraversalRow[];

      if (explicitStartProjectId === undefined) {
        const distinctRootProjects = new Set<string>();
        for (const row of rows) {
          if (typeof row.root_project_id === "string" && row.root_project_id.length > 0) {
            distinctRootProjects.add(row.root_project_id);
          }
        }
        if (distinctRootProjects.size > 1) {
          throw new Error(
            `Ambiguous homonymous start itemId '${originItemId}' across multiple authorized projects; pass TraversalOrigin { projectId, itemId }.`
          );
        }
      }

      const resolvedRootProject =
        explicitStartProjectId ??
        (rows.length > 0 && typeof rows[0]!.root_project_id === "string"
          ? rows[0]!.root_project_id
          : undefined);

      const seen = new Set<string>();
      if (resolvedRootProject) {
        seen.add(encodeGraphNodeKey(resolvedRootProject, originItemId));
      }

      const hits: TraversalHit[] = [];
      for (const row of rows) {
        const projectId = String(row.project_id);
        const itemId = String(row.item_id);
        const hops = typeof row.hops === "number" ? row.hops : Number(row.hops);
        if (!allowedProjects.has(projectId)) continue;
        if (!Number.isInteger(hops) || hops < 1 || hops > maxDepth) continue;

        const key = encodeGraphNodeKey(projectId, itemId);
        if (seen.has(key)) continue;
        seen.add(key);

        hits.push({
          itemId,
          projectId,
          hops,
          via: row.via,
          isInferred: Boolean(row.is_inferred)
        });
      }

      return hits;
    });
  }
}

export function createPostgresGraphStore<
  TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner
>(
  client: AppPostgresClient<TTx>,
  defaultContext?: RlsSessionContext
): PostgresGraphStore<TTx> {
  return new PostgresGraphStore(client, defaultContext);
}

/**
 * Explicit test-only factory that allows injecting a fake `GraphSqlClient` (`{ begin }`)
 * in offline behavioral unit tests without a full `AppPostgresClient`.
 *
 * Production code MUST use `new PostgresGraphStore(appClient, defaultContext)` or
 * `createPostgresGraphStore(appClient, defaultContext)` with a verified `brain_app` client.
 */
export function createPostgresGraphStoreForTesting<
  TTx extends GraphSqlTransactionRunner = GraphSqlTransactionRunner
>(
  sql: GraphSqlClient<TTx>,
  defaultContext?: RlsSessionContext
): PostgresGraphStore<TTx> {
  if (!sql || typeof sql !== "object" || typeof sql.begin !== "function") {
    throw new Error(
      "createPostgresGraphStoreForTesting requires a valid fake GraphSqlClient with a begin(callback) method."
    );
  }
  if ("role" in sql && (sql as { role?: unknown }).role !== "brain_app") {
    throw new Error(
      `createPostgresGraphStoreForTesting rejects non-brain_app role '${String((sql as { role?: unknown }).role)}'.`
    );
  }
  const seamTarget: UnsafeGraphTestSeamTarget<TTx> = {
    [UNSAFE_RAW_SQL_TEST_SEAM]: true,
    sql
  };
  return new PostgresGraphStore(
    seamTarget as unknown as AppPostgresClient<TTx>,
    defaultContext
  );
}

