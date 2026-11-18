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

test("retrieval evals: multi-project exhaustive Precision@K, MRR, and Promptfoo/Ragas record export", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);
  const engine = new ContextEngine(retrieval);
  const now = new Date().toISOString();

  const items = [
    { id: "PAY-1", projectId: "payments", title: "Gateway retry policy", content: "Idempotent retry with exponential backoff for PIX payments.", policy: "internal-project" },
    { id: "PAY-2", projectId: "payments", title: "Webhook HMAC verification", content: "Verify X-Signature-256 HMAC on PIX settlement webhooks.", policy: "internal-project" },
    { id: "PAY-SEC", projectId: "payments", title: "Merchant private key", content: "Private HSM key for PIX settlement.", policy: "restricted-security" },
    { id: "AUTH-1", projectId: "identity", title: "OIDC PKCE flow", content: "Authorization code flow with PKCE S256 for web clients.", policy: "internal-project" },
    { id: "AUTH-2", projectId: "identity", title: "Session token rotation", content: "Refresh token rotation with reuse detection in OIDC.", policy: "internal-project" }
  ];

  for (const item of items) {
    retrieval.upsertItem({
      id: item.id,
      tenantId: "acme",
      projectId: item.projectId,
      domainId: 2,
      type: "business_rule",
      title: item.title,
      content: item.content,
      status: "approved",
      sourceId: "git",
      sourceOrigin: "internal",
      sourceKind: "git",
      sourceVersion: "v1",
      sourceUri: `.brain/${item.id}.yaml`,
      version: 1,
      contentHash: `h-${item.id}`,
      confidence: 1.0,
      trustLevel: "verified",
      isInferred: false,
      tags: [],
      relatedIds: [],
      accessPolicyId: item.policy,
      createdAt: now,
      updatedAt: now
    });
  }

  const multiProjectCases = [
    { projectId: "payments", query: "PIX retry backoff", relevantIds: ["PAY-1"], forbiddenIds: ["PAY-SEC", "AUTH-1"] },
    { projectId: "payments", query: "HMAC webhook signature PIX", relevantIds: ["PAY-2"], forbiddenIds: ["PAY-SEC", "AUTH-2"] },
    { projectId: "identity", query: "OIDC PKCE S256", relevantIds: ["AUTH-1"], forbiddenIds: ["PAY-1", "PAY-SEC"] },
    { projectId: "identity", query: "refresh token rotation OIDC", relevantIds: ["AUTH-2"], forbiddenIds: ["PAY-2", "PAY-SEC"] }
  ];

  const ctx = {
    tenantId: "acme",
    actorId: "eval-multi",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["payments", "identity"],
    allowedPolicies: ["internal-project"]
  };

  let precisionAt1Sum = 0;
  let mrrSum = 0;
  const promptfooRecords = [];
  for (const tc of multiProjectCases) {
    const pack = engine.buildContextPack(ctx, { projectId: tc.projectId, task: tc.query });
    const returnedIds = pack.sources.map((s) => s.id);
    assert.ok(returnedIds.length > 0);
    if (tc.relevantIds.includes(returnedIds[0])) precisionAt1Sum += 1;
    const firstRank = returnedIds.findIndex((id) => tc.relevantIds.includes(id));
    assert.ok(firstRank >= 0, `expected relevant item for ${tc.query}`);
    mrrSum += 1 / (firstRank + 1);
    for (const forbidden of tc.forbiddenIds) {
      assert.equal(returnedIds.includes(forbidden), false, `cross-project/policy leak: ${forbidden}`);
    }
    promptfooRecords.push({
      vars: { projectId: tc.projectId, query: tc.query },
      contexts: pack.sources.map((s) => s.content),
      expectedIds: tc.relevantIds
    });
  }

  const precisionAt1 = precisionAt1Sum / multiProjectCases.length;
  const mrr = mrrSum / multiProjectCases.length;
  assert.equal(precisionAt1, 1);
  assert.equal(mrr, 1);
  assert.equal(promptfooRecords.length, 4);
  console.log(JSON.stringify({ event: "multi_project_eval_summary", cases: multiProjectCases.length, precisionAt1, mrr }));
});
