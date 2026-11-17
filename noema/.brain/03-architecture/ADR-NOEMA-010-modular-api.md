---
id: ADR-NOEMA-010
title: Arquitetura Modular da API Noema (Limite de 600 linhas)
type: architecture_decision
status: approved
domainId: 3
accessPolicyId: internal-project
tags:
  - architecture
  - api
  - fastify
  - modularity
---

# ADR-NOEMA-010: Arquitetura Modular da API Noema

## Decisão
Todo o código da API em `apps/api/src/` deve ser organizado por responsabilidade em subpastas (`routes/`, `runtime/`, `security/`, `services/`), mantendo cada arquivo abaixo de **600 linhas**.

## Estrutura adotada
- `apps/api/src/server.ts`: composição do Fastify, CORS, observabilidade e registro das rotas.
- `apps/api/src/runtime/stores.ts`: inicialização de repositórios PostgreSQL/RLS, cache, `enforceOpa`, `recordAudit` e `authenticateProjectRequest`.
- `apps/api/src/security/rbac.ts`: guarda global de permissões granulares por rota (`registerRbacGuard`).
- `apps/api/src/services/`: clientes e jobs (`ai-worker.ts`, `jobs.ts`, `project-metrics.ts`).
- `apps/api/src/routes/`: módulos de rotas por domínio (`system.ts`, `access-rbac.ts`, `proposals.ts`, `projects-knowledge.ts`, `webhooks.ts`, etc.).

## Consequências
- Facilita manutenção, revisão de código e evolução paralela por humanos e agentes via MCP.
