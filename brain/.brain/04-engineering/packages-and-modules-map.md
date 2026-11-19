---
id: CODE-BRAIN-PACKAGES
title: Mapa Detalhado de Apps e Pacotes (@brain/*)
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Mapa de Código do Monorepo (`brain/`)

| Camada | Pacote / App | Responsabilidade Principal |
|---|---|---|
| Domínio | `@brain/core` | Tipos puros (`KnowledgeItem`, `BrainError`, `TrustLevel`) sem dependências externas |
| Segurança | `@brain/auth` | JWT (`jose`), RBAC/CASL, OAuth2 Manager e `authenticateRequest` |
| Dados | `@brain/database` | Drizzle ORM, RLS (`withTenantRls`), `PgOperationalRepository`, `PgAuthRepository`, `PgMcpAuthRepository` |
| Conhecimento | `@brain/knowledge`, `@brain/ingestion` | Versionamento, privacidade LGPD, `scanForSecrets`, chunking Markdown e parsing |
| Busca & Grafo | `@brain/retrieval`, `@brain/graph` | Busca híbrida HNSW + BM25 + RRF, cache LRU/Valkey e travessia recursiva CTE |
| Inteligência | `@brain/code-intelligence`, `@brain/cross-service`, `@brain/impact-analysis`, `@brain/enterprise-views` | Símbolos AST/SCIP, contratos OpenAPI/AsyncAPI/gRPC, blast radius e Tech Radar |
| Execução | `apps/api`, `apps/mcp-server`, `apps/worker`, `apps/agent-runner`, `apps/web` | Gateway HTTP/MCP (:3333), servidor MCP (70+ tools/resources/prompts), worker `bge-m3` e UI (:3000) |
