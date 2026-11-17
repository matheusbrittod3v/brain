import test from "node:test";
import assert from "node:assert/strict";
import {
  KnowledgeGraphStore,
  PostgresGraphStore,
  createAppPostgresClient,
  createPostgresGraphStore,
  createPostgresGraphStoreForTesting,
  encodeGraphNodeKey,
  validateGraphEdgeForRlsContext,
  type AppPostgresClient,
  type AsyncGraphStore,
  type GraphEdge,
  type GraphSqlClient,
  type GraphSqlTransactionRunner,
  type GraphStoreContract,
  type GraphTraversalRow,
  type RlsSessionContext
} from "../src/index.js";
import type { AuthContext } from "@noema/auth";

interface RecordedGraphStatement {
  txId: number;
  sqlTemplate: string;
  params: readonly unknown[];
}

/**
 * Behavioral offline SQL harness that simulates PostgreSQL transaction-local RLS GUCs,
 * the `knowledge_relations_identity_uq` unique constraint on `INSERT`, and the
 * `WITH RECURSIVE graph_walk` CTE over `knowledge_relations`.
 */
function createBehavioralGraphSqlHarness(opts?: {
  failOnInsert?: Error;
  failOnSelect?: Error;
}) {
  let beginCount = 0;
  const statements: RecordedGraphStatement[] = [];
  const rows: GraphEdge[] = [];

  const sql: GraphSqlClient = {
    async begin<T>(callback: (tx: GraphSqlTransactionRunner) => T | Promise<T>): Promise<T> {
      beginCount += 1;
      const txId = beginCount;
      const localGucs = new Map<string, string>();

      const tx: GraphSqlTransactionRunner = async (
        template: TemplateStringsArray,
        ...parameters: readonly unknown[]
      ) => {
        const sqlTemplate = template.join("?");
        statements.push({ txId, sqlTemplate, params: parameters });

        if (sqlTemplate.includes("set_config('app.current_tenant_id'")) {
          localGucs.set("app.current_tenant_id", String(parameters[0] ?? ""));
          localGucs.set("app.allowed_projects", String(parameters[1] ?? ""));
          localGucs.set("app.allowed_policies", String(parameters[2] ?? ""));
          return [];
        }

        const gucTenant = localGucs.get("app.current_tenant_id");
        const gucProjects = new Set(
          (localGucs.get("app.allowed_projects") ?? "").split(",").filter(Boolean)
        );
        const gucPolicies = new Set(
          (localGucs.get("app.allowed_policies") ?? "").split(",").filter(Boolean)
        );

        if (!gucTenant || gucProjects.size === 0 || gucPolicies.size === 0) {
          throw new Error("RLS violation: transaction-local GUCs were not set on this tx before query.");
        }

        if (sqlTemplate.includes("DELETE FROM knowledge_relations")) {
          const [tenantId, projectId, toProjectId, evidenceUri] = parameters as [string, string, string, string];
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index]!;
            if (row.tenantId === tenantId && row.fromProjectId === projectId && row.toProjectId === toProjectId && row.evidenceUri === evidenceUri && row.metadata?.source === "scip") rows.splice(index, 1);
          }
          return [];
        }

        if (sqlTemplate.includes("INSERT INTO knowledge_relations")) {
          if (opts?.failOnInsert) {
            throw opts.failOnInsert;
          }
          assert.ok(
            sqlTemplate.includes("ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO NOTHING"),
            "INSERT must enforce idempotency via knowledge_relations_identity_uq"
          );
          assert.equal(parameters.length, 12, "Expected 12 bound parameters for INSERT INTO knowledge_relations");

          const [
            tenantId,
            fromProjectId,
            toProjectId,
            fromItemId,
            toItemId,
            fromPolicyId,
            toPolicyId,
            relationType,
            isInferredStr,
            confidenceStr,
            evidenceUri,
            metadataJson
          ] = parameters as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            GraphEdge["relationType"],
            string,
            string,
            string,
            Record<string, unknown>
          ];

          // Enforce PostgreSQL RLS WITH CHECK policy on knowledge_relations
          if (
            tenantId !== gucTenant ||
            !gucProjects.has(fromProjectId) ||
            !gucProjects.has(toProjectId) ||
            !gucPolicies.has(fromPolicyId) ||
            !gucPolicies.has(toPolicyId)
          ) {
            throw new Error("new row violates row-level security policy for table \"knowledge_relations\"");
          }

          // Enforce knowledge_relations_identity_uq (tenant_id, from_project_id, to_project_id, from_item_id, to_item_id, relation_type)
          const duplicate = rows.some(
            (r) =>
              r.tenantId === tenantId &&
              r.fromProjectId === fromProjectId &&
              r.toProjectId === toProjectId &&
              r.fromItemId === fromItemId &&
              r.toItemId === toItemId &&
              r.relationType === relationType
          );
          if (!duplicate) {
            rows.push({
              tenantId,
              fromProjectId,
              toProjectId,
              fromItemId,
              toItemId,
              fromPolicyId,
              toPolicyId,
              relationType,
              isInferred: isInferredStr === "true",
              confidence: Number(confidenceStr),
              ...(evidenceUri ? { evidenceUri } : {}),
            metadata: typeof metadataJson === "string" ? JSON.parse(metadataJson) : metadataJson as Record<string, unknown>
            });
          }
          return [];
        }

        if (sqlTemplate.includes("WITH RECURSIVE params AS")) {
          if (opts?.failOnSelect) {
            throw opts.failOnSelect;
          }

          assert.ok(
            sqlTemplate.includes("jsonb_build_array"),
            "Recursive CTE must encode composite visited_path keys via jsonb_build_array"
          );
          assert.ok(
            !sqlTemplate.includes("|| ':' ||"),
            "Recursive CTE must not use colon-delimited string concatenation for composite keys"
          );
          assert.ok(
            !sqlTemplate.includes("valid_until"),
            "Recursive CTE must align with GraphEdge contract and not assume unexposed valid_until filter"
          );
          assert.equal(parameters.length, 6, "Expected 6 bound parameters for WITH RECURSIVE params CTE");
          const [
            tenantId,
            originProjectParam,
            originItemId,
            allowedProjectsCsv,
            allowedPoliciesCsv,
            maxDepthStr
          ] = parameters as [string, string, string, string, string, string];
          const maxDepth = Number(maxDepthStr);

          const queryProjects = new Set(allowedProjectsCsv.split(",").filter(Boolean));
          const queryPolicies = new Set(allowedPoliciesCsv.split(",").filter(Boolean));

          // Visible edges under both RLS GUCs and explicit query pre-filters
          const visibleEdges = rows.filter(
            (e) =>
              e.tenantId === gucTenant &&
              e.tenantId === tenantId &&
              gucProjects.has(e.fromProjectId) &&
              gucProjects.has(e.toProjectId) &&
              queryProjects.has(e.fromProjectId) &&
              queryProjects.has(e.toProjectId) &&
              gucPolicies.has(e.fromPolicyId) &&
              gucPolicies.has(e.toPolicyId) &&
              queryPolicies.has(e.fromPolicyId) &&
              queryPolicies.has(e.toPolicyId)
          );

          interface WalkState {
            root_project_id: string;
            project_id: string;
            item_id: string;
            hops: number;
            via: GraphEdge["relationType"];
            is_inferred: boolean;
            visited_path: string[];
          }

          const queue: WalkState[] = [];
          const out: GraphTraversalRow[] = [];

          // Base step (hop 1)
          for (const kr of visibleEdges) {
            const matchFrom =
              kr.fromItemId === originItemId &&
              (originProjectParam === "" || kr.fromProjectId === originProjectParam);
            const matchTo =
              kr.toItemId === originItemId &&
              (originProjectParam === "" || kr.toProjectId === originProjectParam);

            if (matchFrom) {
              const state: WalkState = {
                root_project_id: kr.fromProjectId,
                project_id: kr.toProjectId,
                item_id: kr.toItemId,
                hops: 1,
                via: kr.relationType,
                is_inferred: kr.isInferred,
                visited_path: [
                  encodeGraphNodeKey(kr.fromProjectId, originItemId),
                  encodeGraphNodeKey(kr.toProjectId, kr.toItemId)
                ]
              };
              queue.push(state);
              out.push(state);
            } else if (matchTo) {
              const state: WalkState = {
                root_project_id: kr.toProjectId,
                project_id: kr.fromProjectId,
                item_id: kr.fromItemId,
                hops: 1,
                via: kr.relationType,
                is_inferred: kr.isInferred,
                visited_path: [
                  encodeGraphNodeKey(kr.toProjectId, originItemId),
                  encodeGraphNodeKey(kr.fromProjectId, kr.fromItemId)
                ]
              };
              queue.push(state);
              out.push(state);
            }
          }

          // Recursive step (hops 2..maxDepth) joining on composite (project_id, item_id)
          while (queue.length > 0) {
            const gw = queue.shift()!;
            if (gw.hops >= maxDepth) continue;

            for (const kr of visibleEdges) {
              let nextProject: string | null = null;
              let nextItem: string | null = null;

              if (kr.fromProjectId === gw.project_id && kr.fromItemId === gw.item_id) {
                nextProject = kr.toProjectId;
                nextItem = kr.toItemId;
              } else if (kr.toProjectId === gw.project_id && kr.toItemId === gw.item_id) {
                nextProject = kr.fromProjectId;
                nextItem = kr.fromItemId;
              }

              if (nextProject && nextItem) {
                const nextKey = encodeGraphNodeKey(nextProject, nextItem);
                if (!gw.visited_path.includes(nextKey)) {
                  const nextState: WalkState = {
                    root_project_id: gw.root_project_id,
                    project_id: nextProject,
                    item_id: nextItem,
                    hops: gw.hops + 1,
                    via: kr.relationType,
                    is_inferred: kr.isInferred,
                    visited_path: [...gw.visited_path, nextKey]
                  };
                  queue.push(nextState);
                  out.push(nextState);
                }
              }
            }
          }

          out.sort((a, b) => Number(a.hops) - Number(b.hops));
          return out;
        }

        throw new Error(`Unexpected SQL statement in graph harness: ${sqlTemplate}`);
      };

      return await callback(tx);
    }
  };

  return {
    sql,
    getBeginCount: () => beginCount,
    statements,
    rows
  };
}

test("prevents cross-policy leakage during graph traversal", () => {
  const graph = new KnowledgeGraphStore();
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "sub",
    toProjectId: "sub",
    fromItemId: "SVC-1",
    toItemId: "BR-PUBLIC",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "GOVERNED_BY",
    isInferred: false,
    confidence: 1.0
  });
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "sub",
    toProjectId: "sub",
    fromItemId: "SVC-1",
    toItemId: "BR-SECRET",
    fromPolicyId: "internal-project",
    toPolicyId: "restricted-security",
    relationType: "GOVERNED_BY",
    isInferred: false,
    confidence: 1.0
  });

  const devCtx: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const hits = graph.traverseRelated(devCtx, "SVC-1", 2);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemId, "BR-PUBLIC");
});

test("prevents cross-project leakage on A -> B and B -> A edges unless both endpoints are in allowedProjects", () => {
  const graph = new KnowledgeGraphStore();
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    fromItemId: "SVC-A",
    toItemId: "SECRET-B",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "CONSUMES_API",
    isInferred: false,
    confidence: 1.0,
    evidenceUri: ".scip/index.scip",
    metadata: { source: "scip", fromSymbol: "demo Dog#", toSymbol: "demo Animal#" }
  });
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-c",
    toProjectId: "proj-a",
    fromItemId: "SECRET-C",
    toItemId: "SVC-A",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "PUBLISHES_EVENT",
    isInferred: false,
    confidence: 1.0
  });

  const ctxOnlyA: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  assert.deepEqual(graph.traverseRelated(ctxOnlyA, "SVC-A", 2), []);

  const ctxAllowedAB: AuthContext = {
    ...ctxOnlyA,
    allowedProjects: ["proj-a", "proj-b"]
  };

  const hitsAB = graph.traverseRelated(ctxAllowedAB, "SVC-A", 2);
  assert.equal(hitsAB.length, 1);
  assert.equal(hitsAB[0].itemId, "SECRET-B");
  assert.equal(hitsAB[0].projectId, "proj-b");
});

test("requires explicit '__org__' in allowedProjects for organizational edges", () => {
  const graph = new KnowledgeGraphStore();
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "__org__",
    fromItemId: "SVC-A",
    toItemId: "ADR-ORG-001",
    fromPolicyId: "internal-project",
    toPolicyId: "public-org",
    relationType: "DECIDED_BY",
    isInferred: false,
    confidence: 1.0
  });

  const ctxWithoutOrg: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project", "public-org"]
  };

  assert.deepEqual(graph.traverseRelated(ctxWithoutOrg, "SVC-A", 2), []);

  const ctxWithOrg: AuthContext = {
    ...ctxWithoutOrg,
    allowedProjects: ["proj-a", "__org__"]
  };

  const hits = graph.traverseRelated(ctxWithOrg, "SVC-A", 2);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemId, "ADR-ORG-001");
  assert.equal(hits[0].projectId, "__org__");
});

test("prevents multihop traversal across an unauthorized intermediate project (A -> B_denied -> A2)", () => {
  const graph = new KnowledgeGraphStore();
  // Hop 1: proj-a (allowed) -> proj-b (denied)
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    fromItemId: "NODE-A1",
    toItemId: "BRIDGE-B",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DEPENDS_ON",
    isInferred: false,
    confidence: 1.0
  });
  // Hop 2: proj-b (denied) -> proj-a (allowed)
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-b",
    toProjectId: "proj-a",
    fromItemId: "BRIDGE-B",
    toItemId: "NODE-A2",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPACTS",
    isInferred: false,
    confidence: 1.0
  });

  const ctxOnlyA: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  assert.deepEqual(graph.traverseRelated(ctxOnlyA, "NODE-A1", 3), []);

  const ctxWithB: AuthContext = {
    ...ctxOnlyA,
    allowedProjects: ["proj-a", "proj-b"]
  };

  const hits = graph.traverseRelated(ctxWithB, "NODE-A1", 3);
  assert.deepEqual(
    hits.map((h) => ({ itemId: h.itemId, projectId: h.projectId, hops: h.hops })),
    [
      { itemId: "BRIDGE-B", projectId: "proj-b", hops: 1 },
      { itemId: "NODE-A2", projectId: "proj-a", hops: 2 }
    ]
  );
});

test("isolates colliding item IDs across projects when traversing from a project-qualified origin or multihop", () => {
  const graph = new KnowledgeGraphStore();
  // Project A has SHARED-ID -> TARGET-A
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "SHARED-ID",
    toItemId: "TARGET-A",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });
  // Project B ALSO has an unrelated item with the same ID "SHARED-ID" -> TARGET-B
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-b",
    toProjectId: "proj-b",
    fromItemId: "SHARED-ID",
    toItemId: "TARGET-B",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });
  // Hop 1 from ENTRY-A in proj-a reaches SHARED-ID in proj-a; Hop 2 must NOT jump to proj-b's SHARED-ID edges
  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "ENTRY-A",
    toItemId: "SHARED-ID",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DEPENDS_ON",
    isInferred: false,
    confidence: 1.0
  });

  const ctxBothProjects: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["internal-project"]
  };

  // 1. Project-qualified origin { projectId: "proj-a", itemId: "SHARED-ID" } at depth 1 only returns proj-a neighbors (TARGET-A and ENTRY-A), never TARGET-B from proj-b
  const originHits = graph.traverseRelated(
    ctxBothProjects,
    { projectId: "proj-a", itemId: "SHARED-ID" },
    1
  );
  assert.deepEqual(
    originHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId })),
    [
      { projectId: "proj-a", itemId: "TARGET-A" },
      { projectId: "proj-a", itemId: "ENTRY-A" }
    ]
  );

  // 2. Multihop from ENTRY-A -> (proj-a, SHARED-ID) -> (proj-a, TARGET-A), never leaking (proj-b, TARGET-B)
  const multihopHits = graph.traverseRelated(ctxBothProjects, { projectId: "proj-a", itemId: "ENTRY-A" }, 2);
  assert.deepEqual(
    multihopHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj-a", itemId: "SHARED-ID", hops: 1 },
      { projectId: "proj-a", itemId: "TARGET-A", hops: 2 }
    ]
  );

  // 3. Unauthorized origin project returns empty immediately
  const ctxOnlyA: AuthContext = {
    ...ctxBothProjects,
    allowedProjects: ["proj-a"]
  };
  assert.deepEqual(
    graph.traverseRelated(ctxOnlyA, { projectId: "proj-b", itemId: "SHARED-ID" }, 2),
    []
  );

  // 4. Unqualified homonymous string start across multiple authorized projects throws instead of merging
  assert.throws(
    () => graph.traverseRelated(ctxBothProjects, "SHARED-ID", 1),
    /Ambiguous homonymous start itemId 'SHARED-ID'/
  );
});

test("PostgresGraphStore.addEdge is idempotent via knowledge_relations_identity_uq and runs inside AppPostgresClient.withRlsTransaction", async () => {
  const harness = createBehavioralGraphSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["internal-project", "public-org"]
  };

  const appClient: AppPostgresClient<GraphSqlTransactionRunner> = createAppPostgresClient({
    databaseUrl: "postgresql://brain_app:secret_graph_pw@localhost:5432/project_brain_os",
    createSql: () => harness.sql
  });

  const store: AsyncGraphStore = createPostgresGraphStore(appClient, rlsContext);
  const edge: GraphEdge = {
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-b",
    fromItemId: "SVC-A",
    toItemId: "CONTRACT-B",
    fromPolicyId: "internal-project",
    toPolicyId: "public-org",
    relationType: "CONSUMES_API",
    isInferred: false,
    confidence: 1.0,
    evidenceUri: ".scip/index.scip",
    metadata: { source: "scip", fromSymbol: "demo Dog#", toSymbol: "demo Animal#" }
  };

  await store.addEdge(edge);
  await store.addEdge(edge); // idempotent duplicate insert

  assert.equal(harness.getBeginCount(), 2);
  assert.equal(harness.rows.length, 1, "Duplicate edge must be ignored by ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq");
  assert.equal(harness.rows[0]?.evidenceUri, ".scip/index.scip");
  assert.deepEqual(harness.rows[0]?.metadata, { source: "scip", fromSymbol: "demo Dog#", toSymbol: "demo Animal#" });
  assert.deepEqual(harness.statements[1]?.params[11], { source: "scip", fromSymbol: "demo Dog#", toSymbol: "demo Animal#" });
  assert.equal(harness.statements.length, 4);
  assert.equal(harness.statements[0]!.txId, 1);
  assert.equal(harness.statements[1]!.txId, 1);
  assert.ok(!harness.statements[1]!.sqlTemplate.includes("SVC-A"), "SQL template must be parameterized");
});

test("PostgresGraphStore.replaceScipEdges replaces evidence edges in one authorized transaction", async () => {
  const harness = createBehavioralGraphSqlHarness();
  const context: RlsSessionContext = { tenantId: "acme", allowedProjects: ["proj-a"], allowedPolicies: ["internal-project"] };
  const store = createPostgresGraphStoreForTesting(harness.sql, context);
  await store.replaceScipEdges({ tenantId: "acme", projectId: "proj-a", evidenceUri: ".scip/index.scip", edges: [{
    tenantId: "acme", fromProjectId: "proj-a", toProjectId: "proj-a", fromItemId: "FILE-A", toItemId: "SYMBOL-A",
    fromPolicyId: "internal-project", toPolicyId: "internal-project", relationType: "IMPLEMENTS", isInferred: false,
    confidence: 1, evidenceUri: ".scip/index.scip", metadata: { source: "scip", symbol: "demo A#" }
  }] });
  assert.equal(harness.getBeginCount(), 1);
  assert.equal(harness.statements.length, 3, "RLS setup, scoped deletion, and insertion share one transaction");
  assert.equal(harness.statements[1]?.txId, harness.statements[2]?.txId);
  assert.match(harness.statements[1]!.sqlTemplate, /metadata->>'source' = 'scip'/);
  assert.deepEqual(harness.rows[0]?.metadata, { source: "scip", symbol: "demo A#" });
  await assert.rejects(store.replaceScipEdges({ tenantId: "acme", projectId: "proj-b", evidenceUri: ".scip/index.scip", edges: [] }), /not authorized/);
  assert.equal(harness.getBeginCount(), 1, "unauthorized replacement must fail before opening a transaction");
});

test("PostgresGraphStore denies unauthorized addEdge and traverseRelated BEFORE opening a transaction", async () => {
  const harness = createBehavioralGraphSqlHarness();
  const baseContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };
  const store = createPostgresGraphStoreForTesting(harness.sql, baseContext);

  // 1. Unauthorized toProjectId ('proj-b' not in allowedProjects)
  await assert.rejects(
    () =>
      store.addEdge({
        tenantId: "acme",
        fromProjectId: "proj-a",
        toProjectId: "proj-b",
        fromItemId: "A1",
        toItemId: "B1",
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        relationType: "DEPENDS_ON",
        isInferred: false,
        confidence: 1.0
      }),
    /GraphEdge\.toProjectId 'proj-b' is not authorized/
  );

  // 2. Organizational endpoint '__org__' when '__org__' is not in allowedProjects
  await assert.rejects(
    () =>
      store.addEdge({
        tenantId: "acme",
        fromProjectId: "proj-a",
        toProjectId: "__org__",
        fromItemId: "A1",
        toItemId: "ORG-ADR",
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        relationType: "DECIDED_BY",
        isInferred: false,
        confidence: 1.0
      }),
    /GraphEdge\.toProjectId '__org__' is not authorized/
  );

  // 3. Unauthorized policy on either endpoint
  await assert.rejects(
    () =>
      store.addEdge({
        tenantId: "acme",
        fromProjectId: "proj-a",
        toProjectId: "proj-a",
        fromItemId: "A1",
        toItemId: "A2",
        fromPolicyId: "internal-project",
        toPolicyId: "restricted-security",
        relationType: "GOVERNED_BY",
        isInferred: false,
        confidence: 1.0
      }),
    /GraphEdge\.toPolicyId 'restricted-security' is not authorized/
  );

  // 4. Tenant mismatch
  await assert.rejects(
    () =>
      store.addEdge({
        tenantId: "other-tenant",
        fromProjectId: "proj-a",
        toProjectId: "proj-a",
        fromItemId: "A1",
        toItemId: "A2",
        fromPolicyId: "internal-project",
        toPolicyId: "internal-project",
        relationType: "GOVERNED_BY",
        isInferred: false,
        confidence: 1.0
      }),
    /GraphEdge\.tenantId 'other-tenant' does not match/
  );

  // 5. traverseRelated with unauthorized TraversalOrigin.projectId short-circuits before sql.begin
  const ctxOnlyA: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };
  const unauthorizedOriginHits = await store.traverseRelated(
    ctxOnlyA,
    { projectId: "proj-b", itemId: "SHARED-ID" },
    2
  );
  assert.deepEqual(unauthorizedOriginHits, []);

  // 6. Empty allowedProjects or maxDepth <= 0 short-circuits before sql.begin
  assert.deepEqual(
    await store.traverseRelated({ ...ctxOnlyA, allowedProjects: [] }, "A1", 2),
    []
  );
  assert.deepEqual(await store.traverseRelated(ctxOnlyA, "A1", 0), []);

  assert.equal(harness.getBeginCount(), 0, "No transaction may open when pre-transaction guards fail or short-circuit");
});

test("PostgresGraphStore.traverseRelated executes recursive CTE with composite keys, scope guards, and homonymous ID isolation", async () => {
  const harness = createBehavioralGraphSqlHarness();
  const seedContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a", "proj-b", "__org__"],
    allowedPolicies: ["internal-project", "public-org", "restricted-security"]
  };
  const adminStore = createPostgresGraphStoreForTesting(harness.sql, seedContext);

  // Seed edges across proj-a, proj-b, and __org__, including homonymous SHARED-ID and a cycle
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "ENTRY-A",
    toItemId: "SHARED-ID",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DEPENDS_ON",
    isInferred: false,
    confidence: 1.0
  });
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "SHARED-ID",
    toItemId: "TARGET-A",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });
  // Cycle edge TARGET-A -> SHARED-ID in proj-a
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "TARGET-A",
    toItemId: "SHARED-ID",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPACTS",
    isInferred: true,
    confidence: 0.8
  });
  // Homonymous SHARED-ID in proj-b -> TARGET-B
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-b",
    toProjectId: "proj-b",
    fromItemId: "SHARED-ID",
    toItemId: "TARGET-B",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });
  // Organizational edge from TARGET-A (proj-a) -> ADR-ORG-01 (__org__)
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "__org__",
    fromItemId: "TARGET-A",
    toItemId: "ADR-ORG-01",
    fromPolicyId: "internal-project",
    toPolicyId: "public-org",
    relationType: "DECIDED_BY",
    isInferred: false,
    confidence: 1.0
  });
  // Restricted policy edge from TARGET-A (proj-a) -> SEC-01 (proj-a)
  await adminStore.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-a",
    toProjectId: "proj-a",
    fromItemId: "TARGET-A",
    toItemId: "SEC-01",
    fromPolicyId: "internal-project",
    toPolicyId: "restricted-security",
    relationType: "GOVERNED_BY",
    isInferred: false,
    confidence: 1.0
  });

  const queryStore = createPostgresGraphStoreForTesting(harness.sql);

  const ctxProjAAndBNoOrg: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["internal-project", "public-org"]
  };

  // 1. Project-qualified TraversalOrigin { projectId: "proj-a", itemId: "SHARED-ID" } never expands proj-b's SHARED-ID
  const qualifiedHits = await queryStore.traverseRelated(
    ctxProjAAndBNoOrg,
    { projectId: "proj-a", itemId: "SHARED-ID" },
    1
  );
  assert.deepEqual(
    qualifiedHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj-a", itemId: "ENTRY-A", hops: 1 },
      { projectId: "proj-a", itemId: "TARGET-A", hops: 1 }
    ]
  );

  // 2. Multihop from { projectId: "proj-a", itemId: "ENTRY-A" } at depth 3:
  // reaches SHARED-ID (hop 1) and TARGET-A (hop 2), handles cycle without infinite loop or revisiting ENTRY-A,
  // never jumps to (proj-b, TARGET-B), and excludes ADR-ORG-01 (__org__ not in allowedProjects) and SEC-01 (restricted-security not in allowedPolicies)
  const multihopNoOrg = await queryStore.traverseRelated(
    ctxProjAAndBNoOrg,
    { projectId: "proj-a", itemId: "ENTRY-A" },
    3
  );
  assert.deepEqual(
    multihopNoOrg.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj-a", itemId: "SHARED-ID", hops: 1 },
      { projectId: "proj-a", itemId: "TARGET-A", hops: 2 }
    ]
  );

  // 3. Adding '__org__' to allowedProjects unlocks ADR-ORG-01 at hop 3 while still blocking SEC-01
  const ctxWithOrg: AuthContext = {
    ...ctxProjAAndBNoOrg,
    allowedProjects: ["proj-a", "proj-b", "__org__"]
  };
  const multihopWithOrg = await queryStore.traverseRelated(
    ctxWithOrg,
    { projectId: "proj-a", itemId: "ENTRY-A" },
    3
  );
  assert.deepEqual(
    multihopWithOrg.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj-a", itemId: "SHARED-ID", hops: 1 },
      { projectId: "proj-a", itemId: "TARGET-A", hops: 2 },
      { projectId: "__org__", itemId: "ADR-ORG-01", hops: 3 }
    ]
  );

  // 4. Unqualified string start "SHARED-ID" when both proj-a and proj-b are authorized rejects ambiguity
  await assert.rejects(
    () => queryStore.traverseRelated(ctxProjAAndBNoOrg, "SHARED-ID", 1),
    /Ambiguous homonymous start itemId 'SHARED-ID'/
  );

  // 5. Unqualified string start "ENTRY-A" (which only exists in proj-a) resolves unambiguously
  const unambiguousStringHits = await queryStore.traverseRelated(ctxProjAAndBNoOrg, "ENTRY-A", 2);
  assert.deepEqual(
    unambiguousStringHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj-a", itemId: "SHARED-ID", hops: 1 },
      { projectId: "proj-a", itemId: "TARGET-A", hops: 2 }
    ]
  );
});

test("PostgresGraphStore contract compatibility, error propagation, and AppPostgresClient lifecycle", async () => {
  const inMemory: GraphStoreContract = new KnowledgeGraphStore();
  const harness = createBehavioralGraphSqlHarness();
  const appClient = createAppPostgresClient({
    databaseUrl: "postgresql://brain_app:secret_graph_pw@localhost:5432/project_brain_os",
    createSql: () => harness.sql
  });
  const rlsContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };
  const pgStore: GraphStoreContract = new PostgresGraphStore({ sql: appClient, context: rlsContext });

  assert.ok(inMemory);
  assert.ok(pgStore);

  const validEdge = validateGraphEdgeForRlsContext(
    {
      tenantId: "acme",
      fromProjectId: "proj-a",
      toProjectId: "proj-a",
      fromItemId: "A1",
      toItemId: "A2",
      fromPolicyId: "internal-project",
      toPolicyId: "internal-project",
      relationType: "IMPLEMENTS",
      isInferred: false,
      confidence: 1.0
    },
    rlsContext
  );
  assert.equal(validEdge.fromItemId, "A1");

  await appClient.close();
  await assert.rejects(
    () => Promise.resolve(pgStore.addEdge(validEdge)),
    /Application PostgreSQL client is already closed/
  );

  const dbErr = new Error("database connection reset during CTE");
  const failingHarness = createBehavioralGraphSqlHarness({ failOnSelect: dbErr });
  const failingStore = createPostgresGraphStoreForTesting(failingHarness.sql, rlsContext);
  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  await assert.rejects(
    () => failingStore.traverseRelated(ctx, { projectId: "proj-a", itemId: "A1" }, 2),
    (err: unknown) => err === dbErr
  );
});

test("prevents visited_path delimiter collision when projectId and itemId contain colons (e.g. 'proj:a'+'b' vs 'proj'+'a:b')", async () => {
  // ("proj:a", "b") and ("proj", "a:b") would both produce "proj:a:b" under colon concatenation,
  // falsely marking ("proj", "a:b") as already visited in visited_path and truncating the walk!
  assert.notEqual(
    encodeGraphNodeKey("proj:a", "b"),
    encodeGraphNodeKey("proj", "a:b"),
    "JSON 2-tuple encoding must keep ('proj:a', 'b') and ('proj', 'a:b') distinct"
  );

  const edgeHop1: GraphEdge = {
    tenantId: "acme",
    fromProjectId: "proj:a",
    toProjectId: "proj",
    fromItemId: "b",
    toItemId: "a:b",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "CONSUMES_API",
    isInferred: false,
    confidence: 1.0
  };
  const edgeHop2: GraphEdge = {
    tenantId: "acme",
    fromProjectId: "proj",
    toProjectId: "proj",
    fromItemId: "a:b",
    toItemId: "final:target",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DEPENDS_ON",
    isInferred: false,
    confidence: 1.0
  };

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev-colon",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj:a", "proj"],
    allowedPolicies: ["internal-project"]
  };

  // 1. In-memory KnowledgeGraphStore
  const memStore = new KnowledgeGraphStore();
  memStore.addEdge(edgeHop1);
  memStore.addEdge(edgeHop2);

  const memHits = memStore.traverseRelated(ctx, { projectId: "proj:a", itemId: "b" }, 2);
  assert.deepEqual(
    memHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj", itemId: "a:b", hops: 1 },
      { projectId: "proj", itemId: "final:target", hops: 2 }
    ]
  );

  // 2. PostgresGraphStore via behavioral SQL harness
  const harness = createBehavioralGraphSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj:a", "proj"],
    allowedPolicies: ["internal-project"]
  };
  const pgStore = createPostgresGraphStoreForTesting(harness.sql, rlsContext);
  await pgStore.addEdge(edgeHop1);
  await pgStore.addEdge(edgeHop2);

  const pgHits = await pgStore.traverseRelated(ctx, { projectId: "proj:a", itemId: "b" }, 2);
  assert.deepEqual(
    pgHits.map((h) => ({ projectId: h.projectId, itemId: h.itemId, hops: h.hops })),
    [
      { projectId: "proj", itemId: "a:b", hops: 1 },
      { projectId: "proj", itemId: "final:target", hops: 2 }
    ]
  );
});

test("PostgresGraphStore rejects raw RlsSqlClient, non-brain_app roles, and forged test seams on the production path (fail-closed)", () => {
  const harness = createBehavioralGraphSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  // 1. Direct constructor call with raw RlsSqlClient fails closed
  assert.throws(
    () => new PostgresGraphStore(harness.sql as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 2. Options constructor call with raw RlsSqlClient fails closed
  assert.throws(
    () => new PostgresGraphStore({ sql: harness.sql as never, context: rlsContext }),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 3. Production factory call with raw RlsSqlClient fails closed
  assert.throws(
    () => createPostgresGraphStore(harness.sql as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 4. Non-brain_app role wrapper fails closed
  assert.throws(
    () =>
      new PostgresGraphStore(
        {
          role: "brain_system" as never,
          withRlsTransaction: async () => undefined,
          close: async () => undefined
        } as never,
        rlsContext
      ),
    /requires a verified AppPostgresClient bound to role 'brain_app'/
  );

  // 5. Forged external Symbol with the same description cannot bypass the module-private seam
  const forgedSeam = {
    [Symbol("noema.graph.unsafeRawSqlTestSeam")]: true,
    sql: harness.sql
  };
  assert.throws(
    () => new PostgresGraphStore(forgedSeam as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 6. Invalid sql property when defined fails closed; omitted sql property on valid structural AppPostgresClient is accepted
  assert.throws(
    () =>
      new PostgresGraphStore(
        {
          role: "brain_app",
          withRlsTransaction: async () => undefined,
          close: async () => undefined,
          sql: {}
        } as never,
        rlsContext
      ),
    /requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql\.begin/
  );

  const structuralStore = new PostgresGraphStore(
    {
      role: "brain_app",
      withRlsTransaction: async (
        _ctx: RlsSessionContext,
        cb: (tx: GraphSqlTransactionRunner) => Promise<unknown> | unknown
      ) => harness.sql.begin(cb),
      close: async () => undefined
    } as never,
    rlsContext
  );
  assert.ok(structuralStore);

  // 7. Test-only seam still rejects explicit non-brain_app role
  assert.throws(
    () =>
      createPostgresGraphStoreForTesting(
        { begin: harness.sql.begin, role: "brain_system" } as never,
        rlsContext
      ),
    /rejects non-brain_app role 'brain_system'/
  );

  assert.equal(harness.getBeginCount(), 0);
});
