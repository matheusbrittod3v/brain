---
id: VIS-BRAIN-001
title: Brain — Cérebro Universal para Engenharia, Negócios e Agentes IA
type: document
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# Visão Geral do Brain

O **Brain** centraliza arquitetura, regras de negócio, topologias em camadas, fluxos, contratos cross-service, memória episódica/semântica e governança RBAC/CASL em um único grafo pesquisável (**FTS/BM25 + HNSW `pgvector` + Grafo Recursivo**) exposto via **Web UI (`:3000`)**, **API REST (`:3333`)** e **MCP (`Streamable HTTP` + `stdio`)**.

## Pilares do Sistema
1. **Conhecimento Vivo em `.brain/`**: Fonte de verdade versionada em Git (sem pasta `docs/`), indexada com embeddings `bge-m3`.
2. **Segurança & Multi-Tenancy**: OAuth 2.1 PKCE, Device Flow 1-clique, tokens revogáveis (`auth_mcp_tokens`), CASL e PostgreSQL RLS.
3. **Governança & Qualidade**: Regras de negócio (`BR-BRAIN-*`) vinculadas a testes (`VERIFIED_BY`) e análise de impacto cross-service.
4. **Runner Multi-Provider**: Execução orquestrada com roteamento primário/secundário/fallback, cotas FinOps e handoffs.

```mermaid
flowchart LR
  Clients["Codex / Antigravity / Cursor"] -->|OAuth 2.1 PKCE / Bearer| Gateway["API Gateway (:3333/mcp)"]
  WebUI["Nuxt Web UI (:3000)"] -->|REST + SSE| Gateway
  Gateway --> Auth["RBAC + CASL + RLS"]
  Gateway --> Retrieval["Hybrid Retrieval (HNSW + BM25 + Graph)"]
  Gateway --> Runner["Agent Runner (Primary/Secondary/Local)"]
  Retrieval --> PG[("PostgreSQL 16 + pgvector")]
```
