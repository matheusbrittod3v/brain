import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeGraphStore } from "../../packages/graph/dist/src/index.js";
import { HybridRetrievalEngine } from "../../packages/retrieval/dist/src/index.js";
import { ContextEngine } from "../../packages/context-engine/dist/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("retrieval evals: 100+ golden queries recall and zero-leakage", () => {
  const baseQueries = JSON.parse(readFileSync(join(__dirname, "datasets/golden-queries.json"), "utf8"));
  const topics = [
    ["cancelamento assinatura", "BR-SUB-014", "Cancelamento assinatura", "Regra de cancelamento de assinatura (subscription cancellation).", "business_rule", 2],
    ["reembolso proporcional", "BR-SUB-015", "Reembolso proporcional", "Calculo de reembolso proporcional (prorated refund calculation).", "business_rule", 2],
    ["maquina de estados", "ADR-021", "Maquina de estados", "Decisao arquitetural de assinatura.", "architecture_decision", 3],
    ["chargeback disputa", "BR-FIN-002", "Bloqueio chargeback", "Excecao de pagamento em disputa.", "business_rule", 2],
    ["rate limit api", "ADR-030", "Rate limit gateway", "Politica de rate limiting no Fastify.", "architecture_decision", 3],
    ["lgpd exclusao titular", "SEC-010", "Exclusao LGPD", "Processo de exclusao e crypto-shredding.", "risk", 11],
    ["handoff branch efemera", "PROC-001", "Handoff entre IDEs", "Sincronizacao de branch efemera no GitHub.", "process", 2],
    ["onboarding microservico", "SVC-PAY", "Servico de pagamentos", "Mapa de endpoints e eventos do billing.", "service", 3],
    ["cobertura testes e2e", "TST-001", "Suite cancelamento", "Cobertura E2E de cancelamento.", "test", 5],
    ["deploy kubernetes rollback", "OPS-004", "Runbook rollback", "Procedimento de rollback no Kubernetes.", "document", 8]
  ];

  const queries = [...baseQueries];

  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);
  const engine = new ContextEngine(retrieval);
  const now = new Date().toISOString();

  const seed = (id, title, content, accessPolicyId = "internal-project", type = "business_rule", domainId = 2) => {
    retrieval.upsertItem({
      id,
      tenantId: "acme",
      projectId: "sub",
      domainId,
      type,
      title,
      content,
      status: "approved",
      sourceId: "git",
      sourceOrigin: "internal",
      sourceKind: "git",
      sourceVersion: "v1",
      sourceUri: `.brain/${id}.yaml`,
      version: 1,
      contentHash: `h-${id}`,
      confidence: 1.0,
      trustLevel: "verified",
      isInferred: false,
      tags: [],
      relatedIds: [],
      accessPolicyId,
      createdAt: now,
      updatedAt: now
    });
  };

  for (const [, id, title, content, type, domainId] of topics) {
    seed(id, title, content, "internal-project", type, domainId);
  }
  seed("SEC-999", "Cancelamento restrito", "Chave secreta de cancelamento", "restricted-security", "risk", 11);

  graph.addEdge({
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

  const ctx = {
    tenantId: "acme",
    actorId: "eval-runner",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const k = 5;
  let totalSent = 0;
  let totalKnownRelevant = 0;
  let recallAtKSum = 0;
  let forbiddenLeaks = 0;
  for (const row of queries) {
    const pack = engine.buildContextPack(ctx, { projectId: row.projectId, task: row.query });
    const returnedIds = pack.sources.map((s) => s.id);
    const topKIds = returnedIds.slice(0, k);
    totalSent += returnedIds.length;
    totalKnownRelevant += returnedIds.filter((id) => row.expectedIds.includes(id)).length;
    const expectedAtK = row.expectedIds.filter((id) => topKIds.includes(id)).length;
    recallAtKSum += expectedAtK / row.expectedIds.length;
    for (const expected of row.expectedIds) {
      assert.ok(topKIds.includes(expected), `${row.id}: missing expected ${expected} in top ${k}`);
    }
    for (const forbidden of row.forbiddenIds) {
      const leaked = returnedIds.includes(forbidden);
      if (leaked) forbiddenLeaks += 1;
      assert.ok(!leaked, `${row.id}: leaked forbidden ${forbidden}`);
    }
  }
  const recallAtK = recallAtKSum / queries.length;
  const knownRelevantSourceRate = totalSent > 0 ? totalKnownRelevant / totalSent : 0;
  const uniqueQueries = new Set(queries.map((row) => row.query)).size;
  const uniqueExpectedSets = new Set(queries.map((row) => [...row.expectedIds].sort().join("|"))).size;
  assert.ok(queries.length >= 100);
  assert.equal(uniqueQueries, queries.length, "golden query rows must cover distinct queries");
  assert.ok(uniqueExpectedSets >= 10, "golden queries must cover at least ten distinct expected-answer sets");
  assert.equal(recallAtK, 1, `every known relevant item must occur in top ${k}`);
  assert.equal(forbiddenLeaks, 0, "restricted sources must never appear in emitted Context Packs");
  console.log(JSON.stringify({ event: "retrieval_eval_summary", queryCount: queries.length, uniqueQueries, uniqueExpectedSets, recallAtK, knownRelevantSourceRate, forbiddenLeaks }));
});
