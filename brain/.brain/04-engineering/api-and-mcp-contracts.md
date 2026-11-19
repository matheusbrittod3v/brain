---
id: SPEC-BRAIN-CONTRACTS
title: Contratos HTTP da API, System Settings, Escopo __global__, OAuth 2.1 PKCE e Gateway MCP
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: engineering
---

# Contratos HTTP da API Fastify (`:3333`) e Gateway MCP

## 1. Autenticação, Identidade e Configurações Globais

| Método & Rota | Permissão / Escopo | Contrato de Resposta |
| :--- | :--- | :--- |
| `POST /v1/auth/register` | Público (se `BRAIN_REGISTRATION_ENABLED=true`) | `{ token, user: { id, email, name, roles, allowedProjects: [] } }` |
| `POST /v1/auth/login` | Público (Argon2id) | `{ token, user: { id, email, name, roles, allowedProjects, permissions } }` |
| `GET /v1/auth/me` | Autenticado (sem exigir `assertProjectAccess`) | `{ tenantId, actorId, roles, allowedProjects, allowedPolicies, permissions, abilities }` |
| `GET /v1/system/settings` | Autenticado (`?category=`) | `{ items: [{ id, category, key, value, isSecret, updatedBy }] }` (segredos como `"••••••••"`) |
| `PUT /v1/system/settings` | `admin` / `owner` / `tech-lead` | `{ item }` — cria ou atualiza parâmetro no PostgreSQL `system_settings` |
| `DELETE /v1/system/settings/:category/:key` | `admin` / `owner` / `tech-lead` | `{ deleted: true }` |

## 2. Projetos, Conhecimento, Busca Híbrida e Grafo

| Método & Rota | Permissão CASL | Descrição |
| :--- | :--- | :--- |
| `GET /v1/projects` | Autenticado | Lista apenas os projetos vinculados ao usuário (`[]` quando desvinculado) |
| `GET /v1/projects?scope=catalog` | Autenticado (`roles:view`) | Lista todos os projetos existentes no tenant para seleção no modal de vínculos |
| `POST /v1/projects/:projectId/sync-brain` | `knowledge:write` | Sincroniza `.brain/` com `knowledge_items` e enfileira embeddings `bge-m3` |
| `POST /v1/projects/:projectId/search` | `knowledge:search` | Busca híbrida RRF (HNSW cosseno + BM25 FTS + expansão por grafo) |
| `GET /v1/projects/:projectId/graph` | `knowledge:search` | Retorna `{ nodes, edges }` filtrados por RLS e política de acesso |
| `POST /v1/projects/:projectId/proposals` | `proposals:create` | Submete proposta com scan automático de segredos e geração de diff |

## 3. RBAC, CASL & Políticas (Suporta `:projectId` ou `__global__`)

| Método & Rota | Permissão CASL | Comportamento com `__global__` (Usuário Sem Projeto) |
| :--- | :--- | :--- |
| `GET /v1/projects/:projectId/access/users` | `roles:view` | Lista todos os usuários registrados no tenant com `roles` e `allowedProjects` |
| `PUT /v1/projects/:projectId/access/users/:userId/scopes` | `users:assign_roles` | Atualiza `allowedProjects`, `allowedPolicies` e `roles`, sincronizando `project_access_members` |
| `GET /v1/projects/:projectId/access/roles` | `roles:view` | Retorna `DEFAULT_ROLES` (ou cargos customizados quando em projeto vinculado) |
| `GET /v1/projects/:projectId/access/permissions` | Autenticado | Retorna as 42 permissões do `PERMISSION_CATALOG` |
| `GET /v1/projects/:projectId/access/assignments` | `roles:view` | Retorna atribuições do projeto (ou `[]` em `__global__`) |
| `GET /v1/projects/:projectId/access/grants` | `admin` / `appsec` | Lista concessões temporárias JIT ativas (ou `[]` em `__global__`) |

## 4. OAuth 2.1 PKCE e Gateway MCP Streamable HTTP

- `GET /.well-known/oauth-protected-resource` e `GET /.well-known/oauth-authorization-server`: metadados RFC 9728 / RFC 8414.
- `POST /oauth/register` e `POST /oauth/token`: registro dinâmico de clientes MCP (Codex, Cursor, Claude) e troca `authorization_code` com `code_verifier` (`S256`).
- `POST /mcp`, `GET /mcp`, `DELETE /mcp`: transporte MCP Streamable HTTP autenticado por Bearer token OAuth, token MCP (`brn_mcp_...`) ou API Key local.
