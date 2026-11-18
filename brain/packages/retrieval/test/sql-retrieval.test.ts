import assert from "node:assert/strict";
import test from "node:test";
import type { AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import { createAppPostgresClient } from "@brain/database";
import type { GraphEdge } from "@brain/graph";
import {
  PostgresRetrievalEngine,
  SqlRetrievalEngine,
  createPostgresRetrievalEngine,
  createPostgresRetrievalEngineForTesting,
  type RetrievalGraphWalkRow,
  type RetrievalKnowledgeItemRow,
  type RetrievalSqlParameter,
  type RetrievalSqlTransactionRunner,
  type RetrievalVectorRankRow
} from "../src/index.js";

interface FakeEmbeddingRecord {
  tenantId: string;
  projectId: string;
  knowledgeItemId: string;
  accessPolicyId: string;
  embeddingModel: string;
  vector: readonly number[];
}

function makeVector(seedIndex: number, value = 1): number[] {
  const vec = new Array<number>(1024).fill(0);
  vec[seedIndex % 1024] = value;
  return vec;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseVectorLiteral(lit: string): number[] {
  const inner = lit.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return [];
  return inner.split(",").map(Number);
}

/**
 * Stateful fake PostgreSQL retrieval database enforcing transaction-local GUCs,
 * RLS predicates, FTS over `search_vector` (`id`, `title`, `summary`, `content`, `tags`),
 * exact authorized vector cosine similarity, and recursive graph traversal in the same `tx`.
 */
class StatefulFakeRetrievalDb {
  public readonly items: RetrievalKnowledgeItemRow[] = [];
  public readonly embeddings: FakeEmbeddingRecord[] = [];
  public readonly edges: Array<GraphEdge & { validUntil?: string | null }> = [];
  public readonly recordedQueries: Array<{
    txId: number;
    sql: string;
    params: readonly RetrievalSqlParameter[];
  }> = [];
  public beginCalls = 0;

  upsertItem(item: Partial<KnowledgeItem> & Pick<KnowledgeItem, "id" | "tenantId" | "projectId">): void {
    const nowIso = new Date().toISOString();
    const row: RetrievalKnowledgeItemRow = {
      id: item.id,
      tenant_id: item.tenantId,
      project_id: item.projectId,
      domain_id: item.domainId ?? 2,
      type: item.type ?? "business_rule",
      title: item.title ?? "Regra",
      content: item.content ?? "Conteudo",
      summary: item.summary ?? null,
      status: item.status ?? "approved",
      source_id: item.sourceId ?? item.id,
      source_origin: item.sourceOrigin ?? "internal",
      source_kind: item.sourceKind ?? "git",
      source_version: item.sourceVersion ?? "v1",
      source_uri: item.sourceUri ?? `.brain/${item.id}.md`,
      version: item.version ?? 1,
      content_hash: item.contentHash ?? `hash-${item.id}`,
      owner_id: item.ownerId ?? null,
      confidence: item.confidence ?? 1.0,
      trust_level: item.trustLevel ?? "verified",
      is_inferred: item.isInferred ?? false,
      valid_from: item.validFrom ?? item.updatedAt ?? item.createdAt ?? nowIso,
      valid_until: item.validUntil ?? null,
      tags: item.tags ?? [],
      access_policy_id: item.accessPolicyId ?? "internal-project",
      metadata: item.metadata ?? {},
      deleted_at: item.deletedAt ?? null,
      created_at: item.createdAt ?? nowIso,
      updated_at: item.updatedAt ?? nowIso
    };
    const idx = this.items.findIndex(
      (r) => r.tenant_id === row.tenant_id && r.project_id === row.project_id && r.id === row.id
    );
    if (idx >= 0) {
      this.items[idx] = row;
    } else {
      this.items.push(row);
    }
  }

  addEmbedding(record: FakeEmbeddingRecord): void {
    this.embeddings.push(record);
  }

  addEdge(edge: GraphEdge & { validUntil?: string | null }): void {
    this.edges.push(edge);
  }

  createAppClient() {
    return createAppPostgresClient<RetrievalSqlTransactionRunner>({
      databaseUrl: "postgresql://brain_app:dev-secret@localhost:5432/project_brain_os",
      createSql: () => ({
        begin: async <T>(cb: (tx: RetrievalSqlTransactionRunner) => T | Promise<T>): Promise<T> => {
          this.beginCalls += 1;
          const txId = this.beginCalls;
          let gucTenant = "";
          let gucProjects = new Set<string>();
          let gucPolicies = new Set<string>();

          const isRlsAuthorized = (tenantId: string, projectId: string, policyId: string): boolean => {
            return (
              gucTenant.length > 0 &&
              tenantId === gucTenant &&
              gucProjects.has(projectId) &&
              gucPolicies.has(policyId)
            );
          };

          const tx: RetrievalSqlTransactionRunner = async <TRow = Record<string, unknown>>(
            template: TemplateStringsArray,
            ...params: readonly RetrievalSqlParameter[]
          ): Promise<readonly TRow[]> => {
            const sql = template.join("$P$").replace(/\s+/g, " ").trim();
            this.recordedQueries.push({ txId, sql, params });

            // 1. GUC initialization
            if (sql.includes("set_config('app.current_tenant_id'")) {
              gucTenant = String(params[0] ?? "");
              gucProjects = new Set(String(params[1] ?? "").split(",").filter(Boolean));
              gucPolicies = new Set(String(params[2] ?? "").split(",").filter(Boolean));
              return [] as unknown as readonly TRow[];
            }

            if (!gucTenant || gucProjects.size === 0 || gucPolicies.size === 0) {
              throw new Error("RLS fail-closed: query executed before GUC configuration");
            }

            // 2. getItem SELECT
            if (
              sql.startsWith("SELECT") &&
              sql.includes("FROM knowledge_items") &&
              !sql.includes("lexical_rank")
            ) {
              const [tenantId, projectId, id, allowedPoliciesCsv, nowIso] = params as [
                string,
                string,
                string,
                string,
                string
              ];
              const paramPolicies = new Set(allowedPoliciesCsv.split(",").filter(Boolean));
              const nowMs = Date.parse(nowIso);

              const found = this.items.find((r) => {
                if (!isRlsAuthorized(r.tenant_id, r.project_id, r.access_policy_id)) return false;
                if (r.tenant_id !== tenantId || r.project_id !== projectId || r.id !== id) return false;
                if (!paramPolicies.has(r.access_policy_id)) return false;
                if (r.deleted_at !== null) return false;
                if (r.valid_until !== null && Date.parse(String(r.valid_until)) <= nowMs) return false;
                return true;
              });
              return found ? ([structuredClone(found) as unknown as TRow]) : ([] as unknown as readonly TRow[]);
            }

            // 3. search candidate & lexical FTS SELECT
            if (sql.startsWith("SELECT") && sql.includes("AS lexical_rank") && sql.includes("FROM knowledge_items")) {
              const [
                queryEmptyCheck,
                queryMatch,
                queryRank,
                tenantId,
                candidateProjectsCsv,
                allowedPoliciesCsv,
                validFromIso,
                validUntilIso,
                domainsEmptyCheck,
                domainsCsv
              ] = params as [string, string, string, string, string, string, string, string, string, string];
              void queryEmptyCheck;
              void queryMatch;
              void domainsEmptyCheck;

              const candidateProjects = new Set(candidateProjectsCsv.split(",").filter(Boolean));
              const paramPolicies = new Set(allowedPoliciesCsv.split(",").filter(Boolean));
              const domainSet = domainsCsv
                ? new Set(domainsCsv.split(",").filter(Boolean).map(Number))
                : null;
              const effectiveFromMs = Date.parse(validFromIso);
              const effectiveUntilMs = Date.parse(validUntilIso);
              const terms = queryRank
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t.length > 1);

              const matchingRows: RetrievalKnowledgeItemRow[] = [];
              for (const r of this.items) {
                if (!isRlsAuthorized(r.tenant_id, r.project_id, r.access_policy_id)) continue;
                if (r.tenant_id !== tenantId) continue;
                if (!candidateProjects.has(r.project_id)) continue;
                if (!paramPolicies.has(r.access_policy_id)) continue;
                if (r.deleted_at !== null) continue;
                if (r.status === "deprecated" || r.status === "superseded") continue;
                if (r.valid_from !== null && Date.parse(String(r.valid_from)) > effectiveFromMs) continue;
                if (r.valid_until !== null && Date.parse(String(r.valid_until)) <= effectiveUntilMs) continue;
                if (domainSet && !domainSet.has(Number(r.domain_id))) continue;

                const tagsStr = Array.isArray(r.tags) ? r.tags.join(" ") : String(r.tags);
                const searchVectorText = `${r.id} ${r.title} ${r.summary ?? ""} ${r.content} ${tagsStr}`.toLowerCase();
                let matches = 0;
                for (const t of terms) {
                  if (searchVectorText.includes(t)) matches += 1;
                }
                const lexical_rank = terms.length === 0 ? 0.1 : matches / terms.length;
                matchingRows.push({ ...structuredClone(r), lexical_rank });
              }

              return matchingRows as unknown as readonly TRow[];
            }

            // 4. Exact vector similarity over authorized subset
            if (sql.startsWith("SELECT") && sql.includes("FROM knowledge_embeddings ke")) {
              const [
                vectorLiteral,
                tenantId,
                candidateProjectsCsv,
                allowedPoliciesCsv,
                embeddingModel,
                validFromIso,
                validUntilIso,
                domainsEmptyCheck,
                domainsCsv
              ] = params as [string, string, string, string, string, string, string, string, string];
              void domainsEmptyCheck;

              const queryVec = parseVectorLiteral(vectorLiteral);
              const candidateProjects = new Set(candidateProjectsCsv.split(",").filter(Boolean));
              const paramPolicies = new Set(allowedPoliciesCsv.split(",").filter(Boolean));
              const domainSet = domainsCsv
                ? new Set(domainsCsv.split(",").filter(Boolean).map(Number))
                : null;
              const effectiveFromMs = Date.parse(validFromIso);
              const effectiveUntilMs = Date.parse(validUntilIso);

              const bestByItem = new Map<string, RetrievalVectorRankRow>();
              for (const emb of this.embeddings) {
                if (!isRlsAuthorized(emb.tenantId, emb.projectId, emb.accessPolicyId)) continue;
                if (emb.tenantId !== tenantId) continue;
                if (!candidateProjects.has(emb.projectId)) continue;
                if (!paramPolicies.has(emb.accessPolicyId)) continue;
                if (emb.embeddingModel !== embeddingModel) continue;

                const parent = this.items.find(
                  (it) =>
                    it.tenant_id === emb.tenantId &&
                    it.project_id === emb.projectId &&
                    it.id === emb.knowledgeItemId
                );
                if (!parent) continue;
                if (!isRlsAuthorized(parent.tenant_id, parent.project_id, parent.access_policy_id)) continue;
                if (parent.deleted_at !== null) continue;
                if (parent.status === "deprecated" || parent.status === "superseded") continue;
                if (parent.valid_from !== null && Date.parse(String(parent.valid_from)) > effectiveFromMs) continue;
                if (parent.valid_until !== null && Date.parse(String(parent.valid_until)) <= effectiveUntilMs) continue;
                if (domainSet && !domainSet.has(Number(parent.domain_id))) continue;

                const sim = cosineSimilarity(emb.vector, queryVec);
                const key = `${emb.projectId}\0${emb.knowledgeItemId}`;
                const prev = bestByItem.get(key);
                if (!prev || sim > Number(prev.vector_similarity)) {
                  bestByItem.set(key, {
                    project_id: emb.projectId,
                    knowledge_item_id: emb.knowledgeItemId,
                    vector_similarity: sim
                  });
                }
              }

              return [...bestByItem.values()] as unknown as readonly TRow[];
            }

            // 5. Recursive graph walk inside same transaction
            if (sql.startsWith("WITH RECURSIVE params AS")) {
              const [
                tenantId,
                originProject,
                originItem,
                allowedProjectsCsv,
                allowedPoliciesCsv,
                maxDepthParam
              ] = params as [string, string, string, string, string, number];

              const allowedProjects = new Set(allowedProjectsCsv.split(",").filter(Boolean));
              const allowedPolicies = new Set(allowedPoliciesCsv.split(",").filter(Boolean));
              const maxDepth = Number(maxDepthParam);

              const encodeNodeKey = (proj: string, item: string) => JSON.stringify([proj, item]);

              const visited = new Set<string>([encodeNodeKey(originProject, originItem)]);
              const queue: Array<{ projectId: string; itemId: string; hops: number }> = [
                { projectId: originProject, itemId: originItem, hops: 0 }
              ];
              const rows: RetrievalGraphWalkRow[] = [];

              while (queue.length > 0) {
                const cur = queue.shift()!;
                if (cur.hops >= maxDepth) continue;

                for (const edge of this.edges) {
                  if (edge.tenantId !== tenantId || edge.tenantId !== gucTenant) continue;
                  if (!gucProjects.has(edge.fromProjectId) || !gucProjects.has(edge.toProjectId)) continue;
                  if (!gucPolicies.has(edge.fromPolicyId) || !gucPolicies.has(edge.toPolicyId)) continue;
                  if (!allowedProjects.has(edge.fromProjectId) || !allowedProjects.has(edge.toProjectId)) continue;
                  if (!allowedPolicies.has(edge.fromPolicyId) || !allowedPolicies.has(edge.toPolicyId)) continue;

                  let nextProj: string | null = null;
                  let nextItem: string | null = null;
                  if (edge.fromProjectId === cur.projectId && edge.fromItemId === cur.itemId) {
                    nextProj = edge.toProjectId;
                    nextItem = edge.toItemId;
                  } else if (edge.toProjectId === cur.projectId && edge.toItemId === cur.itemId) {
                    nextProj = edge.fromProjectId;
                    nextItem = edge.fromItemId;
                  }

                  if (nextProj && nextItem) {
                    const visitKey = encodeNodeKey(nextProj, nextItem);
                    if (!visited.has(visitKey)) {
                      visited.add(visitKey);
                      rows.push({
                        root_project_id: originProject,
                        project_id: nextProj,
                        item_id: nextItem,
                        hops: cur.hops + 1,
                        via: edge.relationType,
                        is_inferred: edge.isInferred
                      });
                      queue.push({ projectId: nextProj, itemId: nextItem, hops: cur.hops + 1 });
                    }
                  }
                }
              }

              return rows as unknown as readonly TRow[];
            }

            throw new Error(`Unexpected SQL in StatefulFakeRetrievalDb: ${sql}`);
          };

          return await cb(tx);
        }
      })
    });
  }
}

test("PostgresRetrievalEngine fail-closed guards do not open a transaction when project or policies are unauthorized", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new SqlRetrievalEngine(fakeDb.createAppClient());

  const ctxOnlySub: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  // Unauthorized project on search & getItem
  assert.deepEqual(await engine.search(ctxOnlySub, { projectId: "other-proj", query: "regra" }), []);
  assert.deepEqual(await engine.search(ctxOnlySub, { projectId: "__org__", query: "regra" }), []);
  assert.equal(await engine.getItem(ctxOnlySub, "other-proj", "BR-1"), undefined);
  assert.equal(await engine.getItem(ctxOnlySub, "__org__", "BR-1"), undefined);

  // Empty allowedProjects or allowedPolicies
  assert.deepEqual(
    await engine.search({ ...ctxOnlySub, allowedProjects: [] }, { projectId: "sub", query: "regra" }),
    []
  );
  assert.deepEqual(
    await engine.search({ ...ctxOnlySub, allowedPolicies: [] }, { projectId: "sub", query: "regra" }),
    []
  );

  assert.equal(fakeDb.beginCalls, 0, "sql.begin must never be called when pre-transaction guards deny access");
});

test("SQL ranking uses session hit rate only, clamps it, and safely handles zero denominator", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient());
  const ids = ["RATE-ZERO", "RATE-HALF", "RATE-ONE", "RATE-EMPTY"];
  for (const id of ids) {
    fakeDb.upsertItem({ id, tenantId: "acme", projectId: "sub", title: "regra alvo", content: "regra alvo", status: "approved" });
  }
  const setCounts = (id: string, legacy: number, sent: number, hits: number) => {
    const row = fakeDb.items.find((item) => item.id === id)!;
    row.hit_count = legacy;
    row.context_sent_count = sent;
    row.context_hit_count = hits;
  };
  setCounts("RATE-ZERO", 99, 4, 0);
  setCounts("RATE-HALF", 0, 4, 2);
  setCounts("RATE-ONE", 0, 4, 8);
  setCounts("RATE-EMPTY", 99, 0, 0);
  const hits = await engine.search({ tenantId: "acme", actorId: "dev", actorType: "human", roles: ["developer"], allowedProjects: ["sub"], allowedPolicies: ["internal-project"] }, { projectId: "sub", query: "regra alvo", explain: true });
  const boosts = new Map(hits.map((hit) => [hit.item.id, hit.explain?.hitRateBoost]));
  assert.equal(boosts.get("RATE-ZERO"), 0, "legacy hit_count must not affect session ranking");
  assert.equal(boosts.get("RATE-HALF"), 0.5);
  assert.equal(boosts.get("RATE-ONE"), 1, "invalid ratio above one must be clamped");
  assert.equal(boosts.get("RATE-EMPTY"), 0, "zero denominator must not produce NaN");
});

test("PostgresRetrievalEngine executes lexical FTS, exact authorized vector scan, and graph expansion inside the same RLS transaction", async () => {
  const fixedNow = new Date("2026-11-16T18:00:00.000Z");
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient(), undefined, {
    now: () => fixedNow
  });

  // 1. Authorized lexical + vector seed
  fakeDb.upsertItem({
    id: "BR-SUB-014",
    tenantId: "acme",
    projectId: "sub",
    domainId: 2,
    type: "business_rule",
    title: "Cancelamento de assinatura",
    content: "Cliente autorizado pode cancelar assinatura.",
    status: "approved",
    accessPolicyId: "internal-project",
    updatedAt: fixedNow.toISOString()
  });
  fakeDb.addEmbedding({
    tenantId: "acme",
    projectId: "sub",
    knowledgeItemId: "BR-SUB-014",
    accessPolicyId: "internal-project",
    embeddingModel: "bge-m3",
    vector: makeVector(5, 1)
  });

  // 2. Graph neighbor of BR-SUB-014 (no lexical match for 'cancelamento', but semantic/graph neighbor)
  fakeDb.upsertItem({
    id: "ADR-021",
    tenantId: "acme",
    projectId: "sub",
    domainId: 7,
    type: "architecture_decision",
    title: "Maquina de estados de eventos",
    content: "Transicao assincrona de estados.",
    status: "approved",
    accessPolicyId: "internal-project",
    updatedAt: fixedNow.toISOString()
  });
  fakeDb.addEdge({
    tenantId: "acme",
    fromProjectId: "sub",
    toProjectId: "sub",
    fromItemId: "BR-SUB-014",
    toItemId: "ADR-021",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DECIDED_BY",
    isInferred: false,
    confidence: 1.0
  });

  // 3. Unauthorized policy item (even with identical embedding vector, must never affect candidates or scores)
  fakeDb.upsertItem({
    id: "SEC-RESTRICTED",
    tenantId: "acme",
    projectId: "sub",
    domainId: 11,
    title: "Cancelamento chave mestra",
    content: "Cancelamento restrito.",
    accessPolicyId: "restricted-security"
  });
  fakeDb.addEmbedding({
    tenantId: "acme",
    projectId: "sub",
    knowledgeItemId: "SEC-RESTRICTED",
    accessPolicyId: "restricted-security",
    embeddingModel: "bge-m3",
    vector: makeVector(5, 1)
  });

  // 4. Tombstoned, deprecated, superseded, and expired (valid_until <= now) items must be excluded
  fakeDb.upsertItem({
    id: "BR-DELETED",
    tenantId: "acme",
    projectId: "sub",
    title: "Cancelamento antigo deletado",
    content: "Cancelamento.",
    deletedAt: "2026-11-15T00:00:00.000Z"
  });
  fakeDb.upsertItem({
    id: "BR-DEPRECATED",
    tenantId: "acme",
    projectId: "sub",
    title: "Cancelamento depreciado",
    content: "Cancelamento.",
    status: "deprecated"
  });
  fakeDb.upsertItem({
    id: "BR-EXPIRED",
    tenantId: "acme",
    projectId: "sub",
    title: "Cancelamento expirado",
    content: "Cancelamento.",
    validUntil: "2026-11-10T00:00:00.000Z"
  });

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const hits = await engine.search(ctx, {
    projectId: "sub",
    query: "cancelamento",
    queryEmbedding: makeVector(5, 1),
    domains: [2, 7, 11],
    explain: true
  });

  assert.equal(fakeDb.beginCalls, 1, "All queries in search() must run inside a single RLS transaction");
  const txIds = new Set(fakeDb.recordedQueries.map((q) => q.txId));
  assert.deepEqual([...txIds], [1], "GUC setup, FTS, exact vector scan, and graph walk must share the same tx");
  assert.match(fakeDb.recordedQueries[0]!.sql, /set_config\('app\.current_tenant_id'/);

  const returnedIds = hits.map((h) => h.item.id);
  assert.deepEqual(returnedIds, ["BR-SUB-014", "ADR-021"]);
  assert.ok((hits[0]!.explain?.vectorScore ?? 0) > 0.99);
  assert.ok((hits[1]!.explain?.graphProximity ?? 0) > 0);
});

test("PostgresRetrievalEngine includes __org__ only when explicitly in allowedProjects and isolates composite IDs across projects", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient());

  fakeDb.upsertItem({
    id: "SHARED-ID",
    tenantId: "acme",
    projectId: "proj-a",
    title: "Politica local A",
    content: "Regra compartilhada no projeto A",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "TARGET-ID",
    tenantId: "acme",
    projectId: "proj-a",
    title: "Alvo local A",
    content: "Regra alvo A",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "SHARED-ID",
    tenantId: "acme",
    projectId: "proj-b",
    title: "Politica local B",
    content: "Outro item homonimo no projeto B",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "TARGET-ID",
    tenantId: "acme",
    projectId: "proj-b",
    title: "Alvo local B",
    content: "Outro alvo B",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "ORG-RULE-1",
    tenantId: "acme",
    projectId: "__org__",
    title: "Politica global corporativa",
    content: "Regra organizacional",
    accessPolicyId: "public-org"
  });

  // Edge exists only in proj-b between SHARED-ID and TARGET-ID
  fakeDb.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-b",
    toProjectId: "proj-b",
    fromItemId: "SHARED-ID",
    toItemId: "TARGET-ID",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });

  // Boost recorded only on proj-b's TARGET-ID
  engine.recordHitBoost("proj-b", "TARGET-ID", 1.0);

  // 1. Without __org__ in allowedProjects, ORG-RULE-1 is excluded; proj-a TARGET-ID does not inherit proj-b's graph edge or hitBoost
  const ctxWithoutOrg: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["public-org", "internal-project"]
  };

  const hitsAWithoutOrg = await engine.search(ctxWithoutOrg, {
    projectId: "proj-a",
    query: "regra",
    explain: true
  });
  assert.ok(!hitsAWithoutOrg.some((h) => h.item.id === "ORG-RULE-1"));
  const targetInA = hitsAWithoutOrg.find((h) => h.item.id === "TARGET-ID");
  assert.ok(targetInA);
  assert.equal(targetInA.explain?.graphProximity, 0, "proj-a item must not inherit proj-b graph proximity");
  assert.equal(targetInA.explain?.hitRateBoost, 0, "proj-a item must not inherit proj-b hitRateBoost");

  // 2. With __org__ explicitly in allowedProjects, ORG-RULE-1 is included
  const ctxWithOrg: AuthContext = {
    ...ctxWithoutOrg,
    allowedProjects: ["proj-a", "__org__"]
  };
  const hitsAWithOrg = await engine.search(ctxWithOrg, {
    projectId: "proj-a",
    query: "regra",
    explain: true
  });
  assert.ok(hitsAWithOrg.some((h) => h.item.id === "ORG-RULE-1" && h.item.projectId === "__org__"));
});

test("PostgresRetrievalEngine binds query parameters separately and propagates database errors", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient());

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const maliciousQuery = "cancelamento'); DROP TABLE knowledge_items; --";
  await engine.search(ctx, { projectId: "sub", query: maliciousQuery });

  for (const q of fakeDb.recordedQueries) {
    assert.ok(!q.sql.includes("DROP TABLE"), "SQL template must never interpolate raw user query");
  }

  // Error propagation from inside transaction via test seam
  const failingError = new Error("simulated database query failure");
  const failingEngine = createPostgresRetrievalEngineForTesting({
    begin: async (cb) =>
      await cb(async (template) => {
        const sql = template.join("");
        if (sql.includes("set_config")) return [];
        throw failingError;
      })
  });

  await assert.rejects(
    () => failingEngine.search(ctx, { projectId: "sub", query: "regra" }),
    (err) => err === failingError
  );
});

test("PostgresRetrievalEngine and createPostgresRetrievalEngine reject raw RlsSqlClient, non-brain_app role, and forged symbol on production path", () => {
  const rawSqlClient = {
    begin: async <T>(cb: (tx: RetrievalSqlTransactionRunner) => T | Promise<T>) =>
      await cb(async () => [])
  };

  // 1. Raw { begin } rejected by constructor and production factory
  assert.throws(
    () => new PostgresRetrievalEngine(rawSqlClient as unknown as never),
    /raw RlsSqlClient is forbidden on the production path/
  );
  assert.throws(
    () => createPostgresRetrievalEngine(rawSqlClient as unknown as never),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 2. Non-brain_app role rejected
  const wrongRoleClient = {
    role: "brain_system",
    sql: rawSqlClient,
    withRlsTransaction: async () => [],
    close: async () => {}
  };
  assert.throws(
    () => new PostgresRetrievalEngine(wrongRoleClient as unknown as never),
    /received 'brain_system'/
  );
  assert.throws(
    () =>
      createPostgresRetrievalEngineForTesting({
        ...rawSqlClient,
        role: "brain_system"
      } as unknown as never),
    /rejects non-brain_app role 'brain_system'/
  );

  // 3. Forged Symbol("brain.retrieval.unsafeRawSqlTestSeam") rejected
  const forgedSymbol = Symbol("brain.retrieval.unsafeRawSqlTestSeam");
  const forgedSeam = {
    [forgedSymbol]: true,
    sql: rawSqlClient
  };
  assert.throws(
    () => new PostgresRetrievalEngine(forgedSeam as unknown as never),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 4. Incomplete AppPostgresClient (missing close or invalid sql.begin) rejected
  const missingCloseClient = {
    role: "brain_app",
    sql: rawSqlClient,
    withRlsTransaction: async () => []
  };
  assert.throws(
    () => new PostgresRetrievalEngine(missingCloseClient as unknown as never),
    /withRlsTransaction, close, and underlying sql\.begin/
  );
  const invalidInnerSqlClient = {
    role: "brain_app",
    sql: {},
    withRlsTransaction: async () => [],
    close: async () => {}
  };
  assert.throws(
    () => new PostgresRetrievalEngine(invalidInnerSqlClient as unknown as never),
    /withRlsTransaction, close, and underlying sql\.begin/
  );
});

test("traverseGraphInTransaction uses jsonb_build_array(project_id, item_id)::text for visited_path (preventing ':' delimiter collision) and omits kr.valid_until filter", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient());

  // Seed ("proj:a", "b") -> ("proj", "a:b") -> ("proj:a", "TARGET-FINAL")
  // With colon concatenation ("proj:a" + ":" + "b" === "proj:a:b" === "proj" + ":" + "a:b"),
  // ("proj", "a:b") would be falsely skipped as already visited in visited_path!
  fakeDb.upsertItem({
    id: "b",
    tenantId: "acme",
    projectId: "proj:a",
    title: "Seed colon project",
    content: "gatilho colon",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "a:b",
    tenantId: "acme",
    projectId: "proj",
    title: "Intermediate colon item",
    content: "intermediario",
    accessPolicyId: "internal-project"
  });
  fakeDb.upsertItem({
    id: "TARGET-FINAL",
    tenantId: "acme",
    projectId: "proj:a",
    title: "Final colon target",
    content: "destino",
    accessPolicyId: "internal-project"
  });

  // Edge 1: ("proj:a", "b") -> ("proj", "a:b")
  fakeDb.addEdge({
    tenantId: "acme",
    fromProjectId: "proj:a",
    toProjectId: "proj",
    fromItemId: "b",
    toItemId: "a:b",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "DEPENDS_ON",
    isInferred: false,
    confidence: 1.0,
    validUntil: "2020-01-01T00:00:00.000Z" // Parity check: GraphEdge has no valid_until filter in PostgresGraphStore
  });
  // Edge 2: ("proj", "a:b") -> ("proj:a", "TARGET-FINAL")
  fakeDb.addEdge({
    tenantId: "acme",
    fromProjectId: "proj",
    toProjectId: "proj:a",
    fromItemId: "a:b",
    toItemId: "TARGET-FINAL",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPACTS",
    isInferred: false,
    confidence: 1.0
  });

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj:a", "proj"],
    allowedPolicies: ["internal-project"]
  };

  const hits = await engine.search(ctx, {
    projectId: "proj:a",
    query: "gatilho",
    explain: true
  });

  const graphQuery = fakeDb.recordedQueries.find((q) => q.sql.startsWith("WITH RECURSIVE params AS"));
  assert.ok(graphQuery, "Expected recursive graph walk query");
  assert.match(graphQuery.sql, /jsonb_build_array\(p\.origin_project,\s*p\.origin_item\)::text/);
  assert.ok(!graphQuery.sql.includes("|| ':' ||"), "Must not concatenate visited_path with ':' delimiter");
  assert.ok(!graphQuery.sql.includes("kr.valid_until"), "Must not filter knowledge_relations by kr.valid_until");

  const finalTargetHit = hits.find((h) => h.item.id === "TARGET-FINAL" && h.item.projectId === "proj:a");
  assert.ok(finalTargetHit, "Should reach TARGET-FINAL at hop 2 across ('proj:a','b') -> ('proj','a:b')");
  assert.equal(finalTargetHit.explain?.graphProximity, 1 / 3);
});

test("PostgresRetrievalEngine uses pure normalized RRF (0.45 * rrf) when queryEmbedding is present", async () => {
  const fixedNow = new Date("2026-11-16T18:00:00.000Z");
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient(), undefined, {
    now: () => fixedNow
  });

  fakeDb.upsertItem({
    id: "VEC-ONLY-ITEM",
    tenantId: "acme",
    projectId: "sub",
    domainId: 2,
    type: "business_rule",
    title: "Encerramento",
    content: "Processo semantico sem palavra chave.",
    status: "approved",
    accessPolicyId: "internal-project",
    updatedAt: fixedNow.toISOString()
  });
  fakeDb.addEmbedding({
    tenantId: "acme",
    projectId: "sub",
    knowledgeItemId: "VEC-ONLY-ITEM",
    accessPolicyId: "internal-project",
    embeddingModel: "bge-m3",
    vector: makeVector(10, 1)
  });

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const hits = await engine.search(ctx, {
    projectId: "sub",
    query: "cancelamento",
    queryEmbedding: makeVector(10, 1),
    explain: true
  });

  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  // vec = 1.0, lex = 0 -> rank 1 in vec only -> normalizedRrf = (1/61) / (2/61) = 0.5
  // score = 0.45 * 0.5 + 0.25 * 0 + 0.15 * 1.0 + 0.10 * 1.0 + 0.05 * 0 = 0.225 + 0.15 + 0.10 = 0.475
  assert.ok(Math.abs((hit.explain?.rrfScore ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs(hit.score - 0.475) < 1e-9, `Expected 0.475 (pure RRF), got ${hit.score}`);
});

test("PostgresRetrievalEngine supports atDate temporal filter", async () => {
  const fakeDb = new StatefulFakeRetrievalDb();
  const engine = new PostgresRetrievalEngine(fakeDb.createAppClient(), undefined, {
    now: () => new Date("2026-11-16T18:00:00.000Z")
  });

  fakeDb.upsertItem({
    id: "BR-V1",
    tenantId: "acme",
    projectId: "sub",
    title: "Regra v1",
    content: "Regra de cancelamento v1.",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  fakeDb.upsertItem({
    id: "BR-V2",
    tenantId: "acme",
    projectId: "sub",
    title: "Regra v2",
    content: "Regra de cancelamento v2.",
    validFrom: "2026-06-01T00:00:00.000Z",
    validUntil: undefined,
    updatedAt: "2026-06-01T00:00:00.000Z"
  });

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const marchHits = await engine.search(ctx, {
    projectId: "sub",
    query: "cancelamento",
    atDate: "2026-03-01T00:00:00.000Z"
  });
  assert.deepEqual(
    marchHits.map((h) => h.item.id),
    ["BR-V1"]
  );

  const julyHits = await engine.search(ctx, {
    projectId: "sub",
    query: "cancelamento",
    atDate: "2026-07-01T00:00:00.000Z"
  });
  assert.deepEqual(
    julyHits.map((h) => h.item.id),
    ["BR-V2"]
  );
});

test("PostgresRetrievalEngine LRU cache (5m TTL, max 500, policyHash isolation, invalidateCache, external backend)", async () => {
  let currentTimeMs = Date.parse("2026-11-16T18:00:00.000Z");
  const fakeDb = new StatefulFakeRetrievalDb();
  const extStore = new Map<string, string>();
  const invalidatedPrefixes: string[] = [];

  const engine = new PostgresRetrievalEngine({
    client: fakeDb.createAppClient(),
    now: () => new Date(currentTimeMs),
    cacheMaxEntries: 2,
    cache: {
      async get(key) {
        return extStore.get(key) ?? null;
      },
      async set(key, value) {
        extStore.set(key, value);
      },
      async invalidateByPrefix(prefix) {
        invalidatedPrefixes.push(prefix);
        for (const k of extStore.keys()) {
          if (k.startsWith(prefix)) extStore.delete(k);
        }
      }
    }
  });

  fakeDb.upsertItem({
    id: "BR-CACHE-1",
    tenantId: "acme",
    projectId: "sub",
    title: "Cancelamento",
    content: "Politica de cancelamento.",
    accessPolicyId: "internal-project",
    updatedAt: new Date(currentTimeMs).toISOString()
  });

  const ctxA: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };
  const ctxB: AuthContext = {
    ...ctxA,
    allowedPolicies: ["public-org"]
  };

  // First call hits DB
  const res1 = await engine.search(ctxA, { projectId: "sub", query: "cancelamento" });
  assert.equal(res1.length, 1);
  assert.equal(fakeDb.beginCalls, 1);
  assert.equal(extStore.size, 1);

  // Second identical call hits in-process LRU cache (no DB call)
  const res2 = await engine.search(ctxA, { projectId: "sub", query: "cancelamento" });
  assert.equal(res2.length, 1);
  assert.equal(fakeDb.beginCalls, 1);

  // Different policyHash must NOT reuse ctxA's cache entry
  const resB = await engine.search(ctxB, { projectId: "sub", query: "cancelamento" });
  assert.equal(resB.length, 0);
  assert.equal(fakeDb.beginCalls, 2);

  // Advance clock by 5 minutes + 1ms -> TTL expires, hits DB again
  currentTimeMs += 5 * 60 * 1000 + 1;
  extStore.clear();
  await engine.search(ctxA, { projectId: "sub", query: "cancelamento" });
  assert.equal(fakeDb.beginCalls, 3);

  // Explicit invalidateCache clears entries and calls external hook
  engine.invalidateCache("acme", "sub");
  assert.deepEqual(invalidatedPrefixes, ["acme:sub:"]);
  await engine.search(ctxA, { projectId: "sub", query: "cancelamento" });
  assert.equal(fakeDb.beginCalls, 4);
});
