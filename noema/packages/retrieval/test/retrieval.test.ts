import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeGraphStore } from "@noema/graph";
import { HybridRetrievalEngine } from "../src/index.js";
import type { AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";

const baseItem = (overrides: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: "ITEM-1",
  tenantId: "acme",
  projectId: "sub",
  domainId: 2,
  type: "business_rule",
  title: "Regra",
  content: "Conteudo",
  status: "approved",
  sourceId: "src",
  sourceOrigin: "internal",
  sourceKind: "git",
  sourceVersion: "v1",
  sourceUri: ".brain/01-business/BR-1.yaml",
  version: 1,
  contentHash: "hash",
  confidence: 1.0,
  trustLevel: "verified",
  isInferred: false,
  tags: [],
  relatedIds: [],
  accessPolicyId: "internal-project",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

test("enforces pre-retrieval accessPolicyId and expands graph neighbors", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(
    baseItem({
      id: "BR-SUB-014",
      title: "Cancelamento de assinatura",
      content: "Cliente autorizado pode cancelar assinatura."
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "ADR-021",
      domainId: 7,
      type: "architecture_decision",
      title: "Maquina de estados assincrona",
      content: "Decisao de eventos."
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "SEC-999",
      domainId: 11,
      title: "Cancelamento chave secreta",
      content: "Dados restritos de cancelamento.",
      accessPolicyId: "restricted-security"
    })
  );

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

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const results = retrieval.search(ctx, { projectId: "sub", query: "cancelamento", explain: true });
  const ids = results.map((r) => r.item.id);
  assert.ok(ids.includes("BR-SUB-014"));
  assert.ok(ids.includes("ADR-021"), "Should include graph neighbor ADR-021");
  assert.ok(!ids.includes("SEC-999"), "Must never leak restricted-security item");
});

test("context [proj-x] does not return __org__ items or unauthorized project items in search or getItem", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(
    baseItem({
      id: "BR-PROJ-X",
      tenantId: "acme",
      projectId: "proj-x",
      title: "Politica de cobranca local",
      content: "Regra de cobranca do projeto proj-x.",
      accessPolicyId: "internal-project"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "BR-ORG-GLOBAL",
      tenantId: "acme",
      projectId: "__org__",
      title: "Politica de cobranca corporativa",
      content: "Padrao organizacional de cobranca global.",
      accessPolicyId: "public-org"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "BR-PROJ-Y",
      tenantId: "acme",
      projectId: "proj-y",
      title: "Politica de cobranca proj-y",
      content: "Regra de cobranca do projeto proj-y.",
      accessPolicyId: "internal-project"
    })
  );

  const ctxOnlyProjX: AuthContext = {
    tenantId: "acme",
    actorId: "dev-x",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-x"],
    allowedPolicies: ["public-org", "internal-project"]
  };

  // Search within authorized proj-x must NOT auto-include __org__ when __org__ is not in allowedProjects
  const hitsProjX = retrieval.search(ctxOnlyProjX, { projectId: "proj-x", query: "cobranca", explain: true });
  assert.deepEqual(
    hitsProjX.map((h) => h.item.id),
    ["BR-PROJ-X"]
  );

  // Direct search against unauthorized project (proj-y or __org__) must return empty
  assert.deepEqual(
    retrieval.search(ctxOnlyProjX, { projectId: "proj-y", query: "cobranca" }),
    []
  );
  assert.deepEqual(
    retrieval.search(ctxOnlyProjX, { projectId: "__org__", query: "cobranca" }),
    []
  );

  // Direct getItem against authorized project succeeds; against __org__ or proj-y returns undefined
  assert.equal(retrieval.getItem(ctxOnlyProjX, "proj-x", "BR-PROJ-X")?.id, "BR-PROJ-X");
  assert.equal(retrieval.getItem(ctxOnlyProjX, "__org__", "BR-ORG-GLOBAL"), undefined);
  assert.equal(retrieval.getItem(ctxOnlyProjX, "proj-y", "BR-PROJ-Y"), undefined);
});

test("context [proj-x, __org__] returns both project and __org__ items when policies permit and preserves cross-tenant denial", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(
    baseItem({
      id: "BR-PROJ-X",
      tenantId: "acme",
      projectId: "proj-x",
      title: "Padrao de resiliencia servico",
      content: "Timeout e retry no servico proj-x.",
      accessPolicyId: "internal-project"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "BR-ORG-ALLOWED",
      tenantId: "acme",
      projectId: "__org__",
      title: "Padrao de resiliencia organizacional",
      content: "Timeout e retry global da organizacao.",
      accessPolicyId: "public-org"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "BR-ORG-RESTRICTED",
      tenantId: "acme",
      projectId: "__org__",
      title: "Padrao de resiliencia restrito",
      content: "Timeout e retry restrito de seguranca.",
      accessPolicyId: "restricted-security"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "BR-OTHER-TENANT",
      tenantId: "other-org",
      projectId: "proj-x",
      title: "Padrao de resiliencia externo",
      content: "Timeout e retry de outro tenant.",
      accessPolicyId: "public-org"
    })
  );

  const ctxWithOrg: AuthContext = {
    tenantId: "acme",
    actorId: "dev-x",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-x", "__org__"],
    allowedPolicies: ["public-org", "internal-project"]
  };

  const hits = retrieval.search(ctxWithOrg, { projectId: "proj-x", query: "resiliencia", explain: true });
  const ids = hits.map((h) => h.item.id);

  assert.ok(ids.includes("BR-PROJ-X"), "Should return authorized project item");
  assert.ok(ids.includes("BR-ORG-ALLOWED"), "Should return authorized __org__ item when __org__ is in allowedProjects");
  assert.ok(!ids.includes("BR-ORG-RESTRICTED"), "Must still filter out __org__ item with unauthorized policy");
  assert.ok(!ids.includes("BR-OTHER-TENANT"), "Must never leak item from another tenant");

  // Direct getItem works for both authorized scopes and denies other tenant / unauthorized policy
  assert.equal(retrieval.getItem(ctxWithOrg, "proj-x", "BR-PROJ-X")?.id, "BR-PROJ-X");
  assert.equal(retrieval.getItem(ctxWithOrg, "__org__", "BR-ORG-ALLOWED")?.id, "BR-ORG-ALLOWED");
  assert.equal(retrieval.getItem(ctxWithOrg, "__org__", "BR-ORG-RESTRICTED"), undefined);
  assert.equal(retrieval.getItem(ctxWithOrg, "proj-x", "BR-OTHER-TENANT"), undefined);
});

test("isolates graph proximity and hit boosts for homonymous items in authorized projects", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(baseItem({
    id: "SHARED-SEED",
    projectId: "proj-a",
    title: "Needle seed A",
    content: "needle source A"
  }));
  retrieval.upsertItem(baseItem({
    id: "SHARED-TARGET",
    projectId: "proj-a",
    title: "Needle target A",
    content: "needle target A"
  }));
  retrieval.upsertItem(baseItem({
    id: "SHARED-SEED",
    projectId: "proj-b",
    title: "Unrelated seed B",
    content: "unrelated source B"
  }));
  retrieval.upsertItem(baseItem({
    id: "SHARED-TARGET",
    projectId: "proj-b",
    title: "Unrelated target B",
    content: "unrelated target B"
  }));

  graph.addEdge({
    tenantId: "acme",
    fromProjectId: "proj-b",
    toProjectId: "proj-b",
    fromItemId: "SHARED-SEED",
    toItemId: "SHARED-TARGET",
    fromPolicyId: "internal-project",
    toPolicyId: "internal-project",
    relationType: "IMPLEMENTS",
    isInferred: false,
    confidence: 1.0
  });

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["proj-a", "proj-b"],
    allowedPolicies: ["internal-project"]
  };

  const recordProjectBoost = retrieval.recordHitBoost.bind(retrieval) as unknown as (
    projectId: string,
    itemId: string,
    delta?: number
  ) => void;
  recordProjectBoost("proj-b", "SHARED-TARGET", 1);

  const hitsA = retrieval.search(ctx, { projectId: "proj-a", query: "needle", explain: true });
  const targetA = hitsA.find((hit) => hit.item.id === "SHARED-TARGET");
  assert.ok(targetA, "the matching target in proj-a should be returned");
  assert.equal(targetA.explain?.graphProximity, 0, "proj-a origin must not traverse proj-b edges");
  assert.equal(targetA.explain?.hitRateBoost, 0, "proj-b hit boost must not transfer to proj-a");

  const hitsB = retrieval.search(ctx, { projectId: "proj-b", query: "unrelated", explain: true });
  const targetB = hitsB.find((hit) => hit.item.id === "SHARED-TARGET");
  assert.ok(targetB, "the matching target in proj-b should be returned");
  assert.equal(targetB.explain?.hitRateBoost, 1, "proj-b should retain its own hit boost");
});

test("HybridRetrievalEngine enforces atDate temporal filter (validFrom <= atDate and validUntil > atDate)", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(
    baseItem({
      id: "RULE-PAST",
      title: "Regra historica de cobranca",
      content: "Cobranca antiga.",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-06-01T00:00:00.000Z"
    })
  );
  retrieval.upsertItem(
    baseItem({
      id: "RULE-CURRENT",
      title: "Regra vigente de cobranca",
      content: "Cobranca atual.",
      validFrom: "2026-06-01T00:00:00.000Z",
      validUntil: undefined
    })
  );

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const atMarch = retrieval.search(ctx, {
    projectId: "sub",
    query: "cobranca",
    atDate: "2026-03-15T00:00:00.000Z"
  });
  assert.deepEqual(
    atMarch.map((h) => h.item.id),
    ["RULE-PAST"]
  );

  const atJune = retrieval.search(ctx, {
    projectId: "sub",
    query: "cobranca",
    atDate: "2026-06-01T00:00:00.000Z"
  });
  assert.deepEqual(
    atJune.map((h) => h.item.id),
    ["RULE-CURRENT"]
  );
});

test("HybridRetrievalEngine computes vector cosine similarity + normalized RRF when queryEmbedding and item embeddings are provided", () => {
  const graph = new KnowledgeGraphStore();
  const retrieval = new HybridRetrievalEngine(graph);

  retrieval.upsertItem(
    baseItem({
      id: "ITEM-LEX-AND-VEC",
      title: "Cancelamento imediato",
      content: "Fluxo de cancelamento imediato."
    }),
    [1, 0, 0]
  );
  retrieval.upsertItem(
    baseItem({
      id: "ITEM-VEC-ONLY",
      title: "Encerramento contratual",
      content: "Processo semantico equivalente."
    }),
    [0.9, 0.1, 0]
  );

  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const hits = retrieval.search(ctx, {
    projectId: "sub",
    query: "cancelamento",
    queryEmbedding: [1, 0, 0],
    explain: true
  });

  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.item.id, "ITEM-LEX-AND-VEC");
  assert.equal(hits[0]!.explain?.rrfScore, 1); // rank 1 in both lex and vec => (2/61)/(2/61) = 1
  assert.equal(hits[0]!.explain?.vectorScore, 1);
  assert.ok((hits[1]!.explain?.vectorScore ?? 0) > 0.9);
  assert.equal(hits[1]!.item.id, "ITEM-VEC-ONLY");
});


