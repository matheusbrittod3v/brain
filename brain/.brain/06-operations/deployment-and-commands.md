---
id: OPS-BRAIN-001
title: Operação, Variáveis de Ambiente e Comandos
type: document
status: approved
access_policy: internal-project
knowledgeLayer: flows
---

# Operação do Brain

- **Infra**: `bun run infra:up` (sobe PostgreSQL 16 + `pgvector` + Valkey).
- **API + MCP HTTP (`:3333`)**: `bun --env-file=.env apps/api/src/server.ts`.
- **Web UI (`:3000`)**: `cd apps/web && PORT=3000 bun .output/server/index.mjs`.
- **Worker**: `bun --env-file=.env apps/worker/src/index.ts`.
- **CLI MCP**: `brain-mcp login`, `brain-mcp whoami`, `brain-mcp logout`.
