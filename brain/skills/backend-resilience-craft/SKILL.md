---
name: backend-resilience-craft
description: >-
  Engenharia de backend moderna, resiliente e segura com Fastify, TypeScript e Bun:
  Clean Architecture, validação em runtime com TypeBox, isolamento multi-tenant
  com PostgreSQL Row Level Security (RLS), autorização declarativa CASL e graceful shutdown.
---

# Backend Resilience & Architecture Craft

Este guia estabelece os princípios de arquitetura de backend de nível corporativo para aplicações construídas com Fastify, Bun, PostgreSQL e TypeScript.

---

## 1. Clean Architecture & Separação em Camadas

Mantenha separação clara de responsabilidades:
1. **Routes / Handlers**: Apenas extraem parâmetros, autenticam a requisição via `AuthContext`, invocam o caso de uso e retornam o payload HTTP.
2. **Application Services / Use Cases**: Orquestram regras de negócio, coordenam repositórios e disparam eventos de auditoria.
3. **Domain Entities / Rules**: Definem invariantes, tipagens estritas e contratos do sistema.
4. **Repositories / Adapters**: Executam persistência (PostgreSQL, Valkey, S3) com Row-Level Security e conexões seguras.

```text
[HTTP Request] ──► [Routes & TypeBox Schema]
                         │
                         ▼
             [Application Service / Use Case]
             ├── Valida Regras de Negócio (CASL / Guardians)
             ├── Registra Auditoria Imutável
             └── Invoca Repositórios
                         │
                         ▼
             [Operational / Knowledge Repositories]
             └── PostgreSQL com RLS Session (Tenant/Project/Policy)
```

---

## 2. Validação Estrita em Runtime e Compile-Time com TypeBox

Elimine verificações manuais de campos. Declare schemas TypeBox que fornecem validação JSON Schema de alta performance e tipos TypeScript inferidos automaticamente:

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync } from "fastify";

export const CreateProposalSchema = Type.Object({
  title: Type.String({ minLength: 3, maxLength: 120 }),
  domainId: Type.Integer({ minimum: 1, maximum: 12 }),
  summary: Type.String({ minLength: 10 }),
  content: Type.String({ minLength: 20 }),
  tags: Type.Array(Type.String(), { default: [] }),
  accessPolicyId: Type.String({ default: "internal-project" })
});

export type CreateProposalBody = Static<typeof CreateProposalSchema>;

export const proposalRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: CreateProposalBody }>(
    "/v1/projects/:projectId/proposals",
    {
      schema: {
        body: CreateProposalSchema,
        response: {
          201: Type.Object({ id: Type.String(), status: Type.String() })
        }
      }
    },
    async (req, reply) => {
      // req.body já é 100% tipado e validado em tempo de execução
      const result = await proposalService.create(req.body);
      return reply.status(201).send(result);
    }
  );
};
```

---

## 3. Isolamento Multi-Tenant com PostgreSQL RLS

Nunca confie em cláusulas `WHERE tenant_id = '...'` manuais soltas no código. A segurança multi-tenant deve ser garantida na raiz do banco via **Row Level Security**:

```typescript
export async function withTenantRls<T>(
  client: Sql,
  ctx: AuthContext,
  operation: (tx: Sql) => Promise<T>
): Promise<T> {
  const allowedProjectsCsv = ctx.allowedProjects.join(",");
  const allowedPoliciesCsv = ctx.allowedPolicies.join(",");

  return client.begin(async (tx) => {
    // Configura variáveis de sessão antes de qualquer query na transação
    await tx`
      SELECT
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_actor_id', ${ctx.actorId}, true),
        set_config('app.allowed_projects', ${allowedProjectsCsv}, true),
        set_config('app.allowed_policies', ${allowedPoliciesCsv}, true)
    `;

    return operation(tx);
  });
}
```

---

## 4. Tratamento Estruturado de Erros com `BrainError`

Evite strings mágicas de erro ou exceções genéricas. Crie classes de erro de domínio com códigos de erro rastreáveis e status HTTP definidos:

```typescript
export class BrainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "BrainError";
  }
}

// Handlers globais no Fastify
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof BrainError) {
    return reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
      details: error.details
    });
  }

  // Falhas inesperadas: mascarar detalhes sensíveis em produção
  return reply.status(500).send({
    error: "INTERNAL_SERVER_ERROR",
    message: "Ocorreu uma falha interna não tratada."
  });
});
```

---

## 5. Graceful Shutdown & Probes Operacionais

Sempre intercepte sinais de encerramento (`SIGINT`, `SIGTERM`) para fechar conexões ativas com o banco, esvaziar pools e cancelar tarefas em segundo plano sem corromper transações:

```typescript
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  process.on(signal, async () => {
    console.log(`Recebido ${signal}, iniciando encerramento gracioso...`);
    await app.close();
    await databaseClient.close();
    await valkeyClient.quit();
    process.exit(0);
  });
}
```

---

## 6. Checklist de Engenharia Backend
- [ ] O arquivo respeita estritamente o teto de 700 linhas?
- [ ] Todas as rotas possuem schemas TypeBox para body, query e params?
- [ ] Operações de banco passam pela transação com RLS (`withTenantRls`)?
- [ ] Erros são mapeados para `BrainError` sem vazar stacktraces sensíveis?
- [ ] Nenhuma credencial ou segredo é gravado em logs ou respostas da API?
