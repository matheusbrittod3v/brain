---
id: ONB-BRAIN-001
title: Guia Rápido de Desenvolvimento e Conexão MCP
type: document
status: approved
access_policy: internal-project
knowledgeLayer: flows
---

# Onboarding do Projeto Brain

- **Runtime**: Bun `1.4+`, TypeScript, Fastify (`apps/api`), Nuxt 4 (`apps/web`), MCP Server (`apps/mcp-server`), Worker (`apps/worker`).
- **Infra**: `bun run infra:up` (PostgreSQL 16 + `pgvector` + Valkey).
- **Build**: `bun run build`.
- **Conexão MCP**:
  - `brain-mcp login` (OAuth 2.1 PKCE 1-clique em `/auth/oauth`, salva `~/.brain/credentials.json`).
  - HTTP Streamable: `http://localhost:3333/mcp` com descoberta OAuth `/.well-known/oauth-protected-resource`.
