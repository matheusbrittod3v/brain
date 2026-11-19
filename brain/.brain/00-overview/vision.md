---
id: VIS-BRAIN-001
title: Brain — Cérebro Universal para Engenharia, Negócios e Agentes IA
type: document
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# Visão Geral do Brain

O **Brain** centraliza arquitetura, regras de negócio, topologias em camadas, fluxos, contratos cross-service, memória episódica/semântica e governança RBAC/CASL em um único grafo pesquisável (FTS + HNSW `pgvector` + Grafo de Relações) exposto via API REST, Web UI e **MCP (Streamable HTTP + stdio)**.

```mermaid
flowchart LR
  Clients["Codex / Antigravity / Cursor"] -->|OAuth 2.1 PKCE / Bearer| Gateway["API Gateway (:3333/mcp)"]
  WebUI["Nuxt Web UI (:3000)"] -->|REST + SSE| Gateway
  Gateway --> Auth["RBAC + CASL + RLS"]
  Gateway --> Retrieval["Hybrid Retrieval (HNSW + BM25 + Graph)"]
  Retrieval --> PG[("PostgreSQL 16 + pgvector")]
```
