---
id: OPS-BRAIN-RUNBOOK-TROUBLESHOOTING
type: document
title: Runbook Operacional e Troubleshooting (Auth, Embeddings, Worker e System Settings)
domainId: 6
status: approved
owner: sre-platform
accessPolicyId: internal-project
tags:
  - runbook
  - troubleshooting
  - operations
  - embeddings
  - rbac
  - system-settings
---

# Runbook Operacional e Troubleshooting do Brain

## 1. Diagnóstico Rápido de Serviços

| Serviço | Porta / Processo | Verificação de Saúde |
| :--- | :--- | :--- |
| **API Fastify + MCP Gateway** | `:3333` (`apps/api/src/server.ts`) | `curl -s http://localhost:3333/v1/health` |
| **Web Studio (Nuxt 4)** | `:3000` (`.output/server/index.mjs`) | `curl -I http://localhost:3000` |
| **Worker Assíncrono (`pg-boss`)** | Daemon (`apps/worker/dist/src/index.js`) | Consome filas `brain.embed-item` e `brain.ingest-git-repo` |
| **PostgreSQL 16 + pgvector** | `:5432` (`docker-postgres-1`) | Tabelas `knowledge_items`, `knowledge_embeddings`, `system_settings` |
| **Ollama (Embeddings & LLM Local)** | `:11434` (`docker-ollama-1`) | Modelos `bge-m3:latest` (1024 dims) e `gemma:2b-instruct-q2_K` |

## 2. Playbooks de Resolução de Incidentes

### 2.1. Usuário Não Consegue Ver ou Desvincular Projetos
- **Sintoma**: Usuário desvinculado continuava vendo projetos ou recebia erro `403 Acesso negado ao projeto` ao logar.
- **Verificação**:
  1. Consultar `GET /v1/auth/me` com o token JWT do usuário.
  2. Verificar se `allowedProjects` em `auth_users` está `[]` e se `project_access_members` foi limpo por `syncUserProjectMemberships`.
  3. Na guia **Acesso, CASL & Políticas**, o frontend utiliza o escopo `__global__` (`/v1/projects/__global__/access/*`) e carrega o catálogo de projetos via `GET /v1/projects?scope=catalog`.

### 2.2. Embeddings Vetoriais (`knowledge_embeddings`) Não Gerados
- **Sintoma**: Itens aprovados em `knowledge_items` sem vetor correspondente em `knowledge_embeddings`.
- **Resolução**:
  1. Confirmar que o modelo `bge-m3` está carregado no Ollama (`curl http://localhost:11434/api/tags`).
  2. Verificar as configurações dinâmicas `embeddings.ollama_base_url` e `embeddings.embedding_model` em `GET /v1/system/settings` ou via MCP `brain_system_settings_get`.
  3. Garantir que o daemon `@brain/worker` está em execução com `BRAIN_PG_BOSS=1`.
  4. Disparar `POST /v1/projects/brain/sync-brain` ou `brain_sync_brain_folder` para enfileirar e indexar novos itens de `.brain/`.

### 2.3. Alteração de Parâmetros sem Editar `.env`
- **Procedimento**:
  - **Via Web UI**: acessar **Perfil -> Configurações (DB)** (`ProfileSettingsTab.vue`), editar a chave desejada (`embeddings`, `runner`, `github`, `smtp`, `policies`) e salvar.
  - **Via MCP**: chamar `brain_system_settings_set` com `{ category, key, value, isSecret }`.
  - **Via REST**: enviar `PUT /v1/system/settings` autenticado com papel `admin`, `owner` ou `tech-lead`.
