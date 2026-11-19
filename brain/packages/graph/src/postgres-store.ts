import type { AuthContext } from "@brain/auth";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext
} from "@brain/database";
import {
  UNSAFE_RAW_SQL_TEST_SEAM,
  assertVerifiedAppPostgresClient,
  encodeGraphNodeKey,
  isUnsafeGraphTestSeamTarget,
  requireGraphToken,
  validateGraphEdgeForRlsContext,
  type AsyncGraphStore,
  type GraphEdge,
  type GraphSqlClient,
  type GraphSqlTransactionRunner,
  type GraphTraversalRow,
  type PostgresGraphStoreOptions,
  type TraversalHit,
  type TraversalOrigin,
  type UnsafeGraphTestSeamTarget
} from "./types.js";

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
        confidence,
        evidence_uri,
        metadata
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
        ${confidenceParam}::real,
        NULLIF(${validated.evidenceUri ?? ""}, ''),
        ${validated.metadata ?? {}}::jsonb
      )
      ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO NOTHING`;
    });
  }

  async deleteScipEdges(input: { tenantId: string; projectId: string; evidenceUri: string; repository?: string }, ctx?: AuthContext | RlsSessionContext): Promise<void> {
    const { context } = this.resolveEffectiveRlsContext(ctx);
    if (input.tenantId !== context.tenantId || !context.allowedProjects.includes(input.projectId)) {
      throw new Error("SCIP edge project is not authorized.");
    }
    await this.runInRlsTransaction(context, async (tx) => {
      if (input.repository) {
        await tx`DELETE FROM knowledge_relations WHERE tenant_id = ${input.tenantId} AND from_project_id = ${input.projectId} AND to_project_id = ${input.projectId} AND evidence_uri = ${input.evidenceUri} AND metadata->>'source' = 'scip' AND metadata->>'sourceRepository' = ${input.repository.toLowerCase()}`;
      } else {
        await tx`DELETE FROM knowledge_relations WHERE tenant_id = ${input.tenantId} AND from_project_id = ${input.projectId} AND to_project_id = ${input.projectId} AND evidence_uri = ${input.evidenceUri} AND metadata->>'source' = 'scip' AND metadata->>'sourceRepository' IS NULL`;
      }
    });
  }

  async replaceScipEdges(input: { tenantId: string; projectId: string; evidenceUri: string; repository?: string; edges: GraphEdge[] }, ctx?: AuthContext | RlsSessionContext): Promise<void> {
    const { context } = this.resolveEffectiveRlsContext(ctx);
    if (input.tenantId !== context.tenantId || !context.allowedProjects.includes(input.projectId)) {
      throw new Error("SCIP edge project is not authorized.");
    }
    const validatedEdges = input.edges.map((edge) => validateGraphEdgeForRlsContext(edge, context));
    for (const edge of validatedEdges) {
      if (edge.tenantId !== input.tenantId || edge.fromProjectId !== input.projectId || edge.toProjectId !== input.projectId || edge.evidenceUri !== input.evidenceUri || edge.metadata?.source !== "scip") {
        throw new Error("SCIP replacement edge does not match the requested scope.");
      }
    }
    await this.runInRlsTransaction(context, async (tx) => {
      if (input.repository) {
        await tx`DELETE FROM knowledge_relations WHERE tenant_id = ${input.tenantId} AND from_project_id = ${input.projectId} AND to_project_id = ${input.projectId} AND evidence_uri = ${input.evidenceUri} AND metadata->>'source' = 'scip' AND metadata->>'sourceRepository' = ${input.repository.toLowerCase()}`;
      } else {
        await tx`DELETE FROM knowledge_relations WHERE tenant_id = ${input.tenantId} AND from_project_id = ${input.projectId} AND to_project_id = ${input.projectId} AND evidence_uri = ${input.evidenceUri} AND metadata->>'source' = 'scip' AND metadata->>'sourceRepository' IS NULL`;
      }
      for (const edge of validatedEdges) {
        await tx`INSERT INTO knowledge_relations (tenant_id, from_project_id, to_project_id, from_item_id, to_item_id, from_policy_id, to_policy_id, relation_type, is_inferred, confidence, evidence_uri, metadata)
          VALUES (${edge.tenantId}, ${edge.fromProjectId}, ${edge.toProjectId}, ${edge.fromItemId}, ${edge.toItemId}, ${edge.fromPolicyId}, ${edge.toPolicyId}, ${edge.relationType}, ${edge.isInferred ? "true" : "false"}::boolean, ${String(edge.confidence)}::real, NULLIF(${edge.evidenceUri ?? ""}, ''), ${edge.metadata ?? {}}::jsonb)
          ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO NOTHING`;
      }
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

