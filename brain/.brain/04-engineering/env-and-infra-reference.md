---
id: CODE-BRAIN-ENV-INFRA
title: Referência de Variáveis (.env) e Serviços Docker
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Variáveis de Ambiente & Infraestrutura

- **PostgreSQL 16 + `pgvector`** (`docker-postgres-1`):
  - `DATABASE_URL` (`brain_app`): conexões da API/MCP com RLS ativo.
  - `DATABASE_SYSTEM_URL` (`brain_system`): worker `pg-boss`, embeddings e descoberta dinâmica de projetos.
  - `DATABASE_ADMIN_URL` (`brain`): migrações e DDL administrativo.
- **Flags de Persistência**: `BRAIN_PG_STORES=1`, `BRAIN_PG_BOSS=1`.
- **IA Local (Ollama `:11434`)**: `OLLAMA_BASE_URL`, `EMBEDDING_MODEL=bge-m3`, `RUNNER_MODEL=gemma:2b-instruct-q2_K`.
- **Fallback Opcional**: `BRAIN_ALLOWED_PROJECTS` e `BRAIN_ALLOWED_POLICIES` atuam apenas como fallback quando não há escopo dinâmico no banco.
