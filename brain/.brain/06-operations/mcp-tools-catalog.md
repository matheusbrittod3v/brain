---
id: OPS-BRAIN-MCP-CATALOG
title: Catálogo Completo de Tools, Resources e Prompts MCP do Brain
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: operations
---

# Catálogo Completo de Tools, Resources e Prompts MCP do Brain

## 1. Descoberta, Sessão e Configurações Dinâmicas (`platform-ops.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_whoami` | `{}` | Retorna identidade, cargos, permissões CASL, `allowedProjects` e perfil do desenvolvedor |
| `brain_list_projects` | `{}` | Lista os projetos acessíveis pelo token autenticado |
| `brain_project_overview` | `{ projectId }` | Retorna contagem por tipo/status e score de saúde do conhecimento |
| `brain_system_settings_get` | `{ category? }` | Lista configurações globais do PostgreSQL (`system_settings`) com segredos mascarados |
| `brain_system_settings_set` | `{ category, key, value, isSecret? }` | Cria ou atualiza configuração dinâmica no PostgreSQL (requer papel admin/owner/tech-lead) |
| `brain_developer_profile_get` / `set` | `{ preferredPackageManager?, ... }` | Lê ou persiste preferências técnicas do desenvolvedor |
| `brain_finops_summary` | `{ projectId }` | Consulta cotas FinOps departamentais e consumo de tokens |
| `brain_secret_scan` | `{ content }` | Verifica textos ou diffs contra vazamento de segredos antes de commitar |
| `brain_enterprise_tech_radar` | `{ projectId }` | Constrói visão Tech Radar a partir do conhecimento aprovado |

## 2. Busca Híbrida, Context Pack, Grafo e Impacto

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_get_context_pack` | `{ projectId, taskTitle, tokenBudget? }` | Monta pacote completo de contexto (regras, ADRs, specs, memórias) dentro do orçamento de tokens |
| `brain_search_knowledge` | `{ projectId, query, limit?, domains? }` | Busca híbrida HNSW (`bge-m3`) + BM25 + expansão por grafo |
| `brain_get_business_rule` | `{ projectId, ruleId }` | Recupera regra de negócio canônica (`BR-*`) e seus invariantes |
| `brain_get_architecture_context` | `{ projectId, query? }` | Recupera ADRs e especificações arquiteturais relevantes |
| `brain_link_knowledge` | `{ projectId, fromId, toId, relation }` | Cria aresta semântica no grafo (`depends_on`, `implements`, `governs`, `verifies`) |
| `brain_traverse_graph` | `{ projectId, rootId, maxDepth? }` | Percorre dependências e impactos no grafo de conhecimento |
| `brain_analyze_change_impact` | `{ projectId, targetId, changeSummary }` | Calcula raio de impacto técnico e de negócio antes de mudanças |
| `brain_validate_cross_service_change` | `{ consumerProjectId, providerProjectId, contractId }` | Valida compatibilidade de contratos entre microsserviços |

## 3. Autoria, Sincronização `.brain/`, Memória, QA e Runner

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_propose_knowledge` | `{ projectId, id?, type, title, content }` | Cria ou atualiza item/proposta de conhecimento com scan de segredos e embedding automático |
| `brain_sync_brain_folder` | `{ projectId, direction? }` | Sincroniza arquivos de `.brain/` com o PostgreSQL e enfileira embeddings `bge-m3` |
| `brain_ingest_git_repo` | `{ projectId, repoPath }` | Ingeri documentos de repositório Git e dispara indexação vetorial |
| `brain_record_memory` | `{ projectId, content, layer? }` | Registra memória operacional (`working`, `episodic`, `semantic`) |
| `brain_memory_consolidate` | `{ projectId? }` | Executa decaimento e consolidação de memórias episódicas |
| `brain_record_test_result` | `{ projectId, testId, ruleIds, status }` | Registra execução de teste automatizado vinculada a regras `BR-*` |
| `brain_runner_DynamicSubAgents` | `{ projectId, objective, subTasks }` | Orquestra execução paralela/sequencial no Brain Agent Runner (primário + secundário) |
| `brain_create_handoff` / `resume_handoff` | `{ projectId, summary, nextSteps }` | Persiste ou retoma pacote de handoff entre agentes |
