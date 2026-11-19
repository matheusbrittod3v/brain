---
id: ONB-BRAIN-001
title: Guia Rápido de Desenvolvimento, Testes e Conexão MCP
type: document
status: approved
access_policy: internal-project
knowledgeLayer: flows
---

# Onboarding do Projeto Brain

## 1. Stack e Pré-requisitos
- **Runtime**: Bun `1.4+`, TypeScript, Fastify (`apps/api`), Nuxt 4 (`apps/web`), MCP Server (`apps/mcp-server`), Worker (`apps/worker`), Runner (`apps/agent-runner`).
- **Infra Docker**: `bun run infra:up` (PostgreSQL 16 + `pgvector`, Ollama `bge-m3`, Temporal, Keycloak, OPA).

## 2. Comandos Principais
- **Build completo**: `bun run build`
- **Testes de regras de negócio**: `bun test tests/business-rules.test.ts`
- **API + MCP HTTP (`:3333`)**: `bun --env-file=.env apps/api/src/server.ts`
- **Web UI (`:3000`)**: `cd apps/web && PORT=3000 bun .output/server/index.mjs`
- **Worker (`bge-m3` + filas)**: `bun --env-file=.env apps/worker/dist/src/index.js`

## 3. Conexão MCP (Codex / Antigravity / Cursor)
- **HTTP Automático (OAuth 2.1 PKCE)**: `http://localhost:3333/mcp`
- **CLI `stdio` (login 1-clique)**: `bun apps/mcp-server/dist/index.js login` (`whoami` / `logout` também disponíveis).
- **Auto-detecção de projeto**: chame `brain_resolve_workspace_project` ao iniciar qualquer sessão.
