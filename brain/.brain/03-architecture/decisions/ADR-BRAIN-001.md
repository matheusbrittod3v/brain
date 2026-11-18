---
id: ADR-BRAIN-001
type: architecture_decision
title: Arquitetura PostgreSQL-First (FTS + pgvector + pg-boss + RLS)
status: approved
access_policy: internal-project
trust_level: verified
tags: [postgres, pgvector, pg-boss, architecture, node-ts]
---

# Contexto

O Brain precisa de persistência transacional, busca híbrida (lexical + vetorial), travessia de grafo, filas assíncronas e isolamento multi-tenant rigoroso sem multiplicar dependências operacionais no ambiente local e em produção.

# Decisão

Adotar **PostgreSQL 16** como núcleo único de dados e filas no Hub:
- **Busca lexical:** PostgreSQL FTS com índices GIN.
- **Busca vetorial:** `pgvector >= 0.8` (1024 dimensões, `bge-m3` via Ollama opcional) com busca exata pré-filtrada por escopo RLS.
- **Grafo:** tabela `knowledge_relations` com travessia recursiva CTE respeitando `tenant_id`, `project_id` e `access_policy_id` em cada salto.
- **Filas e Crons:** `pg-boss` sobre o mesmo banco, executado pelo `@brain/worker`.
- **Edge Offline:** SQLite + FTS5 + SQLCipher (`@brain/database-edge`) sincronizado via `sync_changes`.

