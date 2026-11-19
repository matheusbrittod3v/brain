---
name: fullstack-testing-strategy
description: >-
  Estratégia completa de testes de software: pirâmide de testes (unitários rápidos
  com Bun Test, integração real com PostgreSQL RLS e E2E), vinculação de testes a regras
  de negócio (VERIFIED_BY), prevenção de regressões e cobertura de 100% em regras críticas.
---

# Fullstack Testing Strategy & Quality Assurance

Uma suíte de testes robusta é o principal alicerce para refatorações seguras, confiança no deploy e documentação viva da arquitetura.

---

## 1. A Pirâmide de Testes Moderna

```text
       / \
      / E2E \         Testes Ponta a Ponta (Playwright / Fastify Inject)
     /───────\        Fluxos completos do usuário, login, navegação e APIs
    / Integração \     Testes com PostgreSQL Real, Valkey, RLS e Policies
   /───────────────\   Transações, constraints e isolamento multi-tenant
  /    Unitários    \  Bun Test / Vitest: regras puras, cálculo de métricas,
 /───────────────────\ parsers, validação de tipos, tempo de execução < 10ms
```

---

## 2. Testes Unitários de Alta Velocidade com Bun Test

- **Foco**: Algoritmos puros, parsers, detectores de contradição, cálculos matemáticos/FinOps.
- **Princípio**: Sem dependências de I/O, sem chamadas de rede ou banco, determinísticos.

```typescript
import { describe, expect, it } from "bun:test";
import { computeKnowledgeHealth } from "@brain/knowledge-health";

describe("Knowledge Health Engine", () => {
  it("TEST-HEALTH-001: aplica penalidade severa para regras críticas sem teste", () => {
    const rules = [
      { id: "BR-SEC-001", type: "business_rule", status: "approved", tags: ["critical"], metadata: {} }
    ];
    const report = computeKnowledgeHealth(rules as any, []);
    expect(report.healthScore).toBeLessThan(90);
    expect(report.untestedRuleIds).toContain("BR-SEC-001");
  });
});
```

---

## 3. Testes de Integração com Banco Real (PostgreSQL & RLS)

Evite mocks de banco de dados (`jest-mock-extended` ou in-memory SQLite): eles mascaram erros de sintaxe SQL, não testam triggers e não validam **Row Level Security**.
- Conecte ao PostgreSQL de desenvolvimento/teste.
- Execute operações dentro de `withTenantRls`.
- Valide explicitamente que o isolamento multi-tenant lança exceção ou oculta dados de outros tenants.

```typescript
import { describe, expect, it } from "bun:test";
import { createAppPostgresClient } from "@brain/audit-engine";
import { PgOperationalRepository } from "@brain/database";

const client = createAppPostgresClient(process.env.DATABASE_URL!);
const opRepo = new PgOperationalRepository(client);

describe("PostgreSQL Multi-Tenant RLS Integration", () => {
  const tenantACtx = {
    tenantId: "tenant-a",
    actorId: "user-a",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["project-alpha"],
    allowedPolicies: ["internal-project"]
  };

  const tenantBCtx = {
    ...tenantACtx,
    tenantId: "tenant-b",
    allowedProjects: ["project-beta"]
  };

  it("garante que tenant-b não consegue ler registros de tenant-a", async () => {
    // Gravar com tenant A
    await opRepo.insertSetting(tenantACtx, "sec_key", "secret-value-a");

    // Tentar ler com tenant B -> deve retornar vazio
    const settingsB = await opRepo.listSettings(tenantBCtx);
    const leaked = settingsB.find((s) => s.key === "sec_key");
    expect(leaked).toBeUndefined();
  });
});
```

---

## 4. Vinculação de Testes a Regras de Negócio (`VERIFIED_BY`)

Para manter a saúde do projeto em 100% e alimentar a Matriz de Cobertura Corporativa:
1. Todo teste que valida uma regra deve declarar o identificador da regra no nome do teste:
   `it("TEST-BR-BRAIN-001: enforces multi-tenant project and policy scope", () => { ... })`
2. Registre a relação `VERIFIED_BY` entre a regra e o teste na tabela `knowledge_relations`.
3. Registre o resultado da execução com `status: 'passed'` no commit HEAD em `test_execution_results`.

---

## 5. Testes E2E de API com Injeção HTTP (Zero Overhead de Porta)

No Fastify, use `app.inject()` para rodar requisições HTTP reais através de todos os middlewares, rotas e serializações JSON sem abrir portas de rede:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { buildApp } from "../src/server.js";

describe("API E2E Contracts", () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/projects/:projectId/health retorna score 100 quando aprovado", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/projects/brain/overview",
      headers: {
        authorization: "Bearer brain-local-dev-secret-2026-key"
      }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.health.healthScore).toBe(100);
    expect(body.health.untestedRuleIds.length).toBe(0);
  });
});
```

---

## 6. Checklist de Qualidade de Testes
- [ ] O arquivo de teste possui menos de 700 linhas?
- [ ] O teste é determinístico (não falha intermitentemente por timeouts ou sleep)?
- [ ] Testes unitários executam em milissegundos sem dependência de banco?
- [ ] Testes de integração validam cenários negativos de permissão e RLS?
- [ ] 100% das regras de negócio possuem testes automatizados associados?
