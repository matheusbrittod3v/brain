---
id: OPS-BRAIN-MCP-CATALOG
title: Catálogo Completo de Tools, Resources e Prompts MCP do Brain
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: operations
---

# Catálogo Completo de Tools, Resources e Prompts MCP do Brain

Fonte de verdade: registro via `server.tool()` em `apps/mcp-server/src/**`. Total atual: **104 tools** registradas, espelhadas em `protocols/mcp-tools/catalog.json` (lista ordenada de nomes, usada em testes de paridade HTTP/stdio). As descrições das tools são prefixadas pelo perfil da conexão (`brain` HTTP compartilhado ou `brain_local` stdio) — leia o prefixo antes de operações de escrita.

## 1. Governança, Regras e Validação (`tools/core-governance.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_analyze_change_impact` | `{ projectId }` | Calcula impactos confirmados vs. hipóteses antes de alterar código ou regras. |
| `brain_change_decide` | `{ projectId, proposalId, decision, note }` | Registra decisão autorizada sobre uma proposta (humanos autorizados ou agentes vinculados a usuário com herança de permissões). |
| `brain_change_propose` | `{ projectId, title, content, targetType, layer, format, … }` | Submete proposta formal em status draft (com suporte a camada, formato de diagrama/topologia e tags). |
| `brain_create_handoff` | `{ projectId, taskId, plan, fromAgent, repoUrl, branch, … }` | Salva checkpoint validado (branch, commit, arquivos, testes, próximos passos) para outra IDE. |
| `brain_delegate_task` | `{ projectId, instruction, cron, priority }` | Enfileira uma tarefa em background para o Brain Runner ou agenda execuções recorrentes via cron UTC. |
| `brain_record_learning` | `{ projectId, summary, usedItemIds, sessionId, taskId, editedPaths, … }` | Registra memória episódica e feedback de utilidade (Context Hit Rate). |
| `brain_resume_handoff` | `{ projectId }` | Retoma tarefa iniciada em outra IDE verificando divergências de branch/commit e leases. |
| `brain_validate_implementation` | `{ projectId, paths, diffOrPaths, mode, limit }` | Valida um conjunto de arquivos/diff contra regras e decisões conhecidas. |

## 2. Busca, Contexto e Recuperação (`tools/core-retrieval.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_bootstrap_project` | `{ projectId, workspacePath, branch, createIfMissing, installAgentRules, name, … }` | Identifica ou cadastra um projeto/branch e retorna visão geral, regras iniciais e alertas. |
| `brain_context_build` | `{ projectId, task, intent, includeDomains, tokenBudget, explain, … }` | Monta um Context Pack otimizado em tokens (regras, ADRs, código, testes, citações). |
| `brain_find_related_code` | `{ projectId }` | Localiza símbolos, arquivos e testes relacionados a uma regra ou requisito. |
| `brain_get_active_rules` | `{ projectId, query, serviceId, tags, limit, cursor, … }` | Lista regras de negócio e padrões vigentes do projeto. |
| `brain_get_layered_knowledge` | `{ projectId, layer, format, query, minQuality, limit }` | Retorna conhecimento estruturado por camada (arquitetura, negócio, código, produto, operação), formato, qualidade e diagramas/topologias extraídos. |
| `brain_install_agent_instructions` | `{ workspacePath, includeGlobal }` | Instala a skill brain-mcp-advisor e adiciona instruções do Brain em AGENTS.md, CLAUDE.md e regras do Cursor. |
| `brain_knowledge_get` | `{ projectId, id, version, depth, sessionId }` | Obtém um KnowledgeItem específico por ID e suas relações seguras no grafo. |
| `brain_resolve_workspace_project` | `{ workspacePath, repoUrl }` | Detecta automaticamente o projectId a partir do diretório de trabalho (cwd) ou git remote, sem depender de IDs no .env. |
| `brain_search` | `{ projectId, query, domains, atDate, limit, cursor, … }` | Busca híbrida direta (lexical + grafo + filtros de domínio) com paginação. |

## 3. Plataforma, Sessão e Configurações (`tools/extended/platform-ops.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_audit_query` | `{ projectId }` | Consulta eventos recentes de auditoria (incluindo ações por cliente MCP). |
| `brain_developer_profile_get` | `{}` | Lê as preferências técnicas do desenvolvedor autenticado. |
| `brain_developer_profile_set` | `{ preferredPackageManager, preferredTestLayout, preferredArchitectureStyle, codingConventions, preferredHarness, optInCrossProject }` | Salva preferências técnicas do desenvolvedor (package manager, estilo, convenções). |
| `brain_enterprise_tech_radar` | `{ projectId }` | Gera visão Tech Radar a partir dos conhecimentos aprovados do projeto. |
| `brain_finops_summary` | `{ projectId }` | Consulta cotas FinOps e métricas de uso de tokens de um projeto. |
| `brain_list_projects` | `{}` | Lista todos os projetos acessíveis pelo usuário autenticado (incluindo projetos marcados como compartilháveis/globais). |
| `brain_list_shared_projects` | `{ includeItems }` | Lista projetos marcados como compartilháveis/reutilizáveis (isShared=true) e suas skills, regras de negócio e especificações globais (requer projects:shared:read). |
| `brain_memory_consolidate` | `{ projectId }` | Consolida memórias episódicas antigas em resumos semânticos. |
| `brain_project_overview` | `{ projectId }` | Retorna visão executiva e saúde do conhecimento de um projeto. |
| `brain_project_set_shared` | `{ projectId, isShared }` | Marca ou desmarca um projeto como compartilhável e reutilizável globalmente entre projetos e agentes MCP (requer permissão projects:share). |
| `brain_secret_scan` | `{ content }` | Analisa trechos de texto ou diffs contra vazamento de segredos e chaves antes de commitar. |
| `brain_system_settings_get` | `{ category }` | Lista as configurações globais persistidas no PostgreSQL (embeddings, runner, github, smtp, policies) com segredos mascarados. |
| `brain_system_settings_set` | `{ category, key, value, isSecret }` | Cria ou atualiza uma configuração global no PostgreSQL (requer papel admin/owner/tech-lead). |
| `brain_whoami` | `{}` | Retorna identidade, cargos, permissões e escopo dinâmico da sessão atual. |

## 4. Ingestão e Saúde do Conhecimento (`tools/extended/ingestion-knowledge.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_ingest_document` | `{ projectId, filename, contentBase64, accessPolicyId }` | Extrai texto de documento (PDF/DOCX/TXT via AI Worker) com scan de segredos e persiste como conhecimento. |
| `brain_ingest_knowledge` | `{ projectId, filePath, content, accessPolicyId }` | Ingere arquivo ou snippet de conhecimento (Markdown/YAML) com scan de segredos e persistência SQL/retrieval. |
| `brain_knowledge_diff` | `{ projectId, itemId, fromVersion, toVersion }` | Compara duas versões (fromVersion vs toVersion) de um item de conhecimento. |
| `brain_knowledge_health` | `{ projectId }` | Retorna relatório estrutural de saúde do projeto (regras sem aresta VERIFIED_BY, itens >90d, conflitos). Nota: este healthScore mede vínculos no grafo; a Matriz Corporativa (Visões Corporativas) exige também execução de teste 'passed' (CI) além da aresta VERIFIED_BY. |
| `brain_living_docs_suggest` | `{ projectId, changedFiles }` | Sugere quais ADRs, contratos ou docs vivos devem ser revisados dado um conjunto de arquivos alterados. |
| `brain_plan_tasks` | `{ projectId, epicDescription, targetFiles, impactedRuleIds }` | Quebra uma feature ou épico em histórias e tarefas ordenadas por prioridade e dependências. |
| `brain_temporal_query` | `{ projectId, atDate, query, limit }` | Consulta o estado do conhecimento válido em uma data ISO-8601 UTC (Project Time Machine). |

## 5. Inteligência, Grafo e Análise de Impacto (`tools/extended/intelligence-tools.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_change_assistant` | `{ projectId, plan, diff, filePaths }` | Assistente de mudança: analisa plano/diff e aponta regras afetadas, arquivos e nível de risco. |
| `brain_contradiction_detect` | `{ projectId }` | Detecta contradições e inconsistências entre regras de negócio, ADRs e políticas de acesso. |
| `brain_decision_timeline` | `{ projectId }` | Linha do tempo histórica de decisões de arquitetura (ADRs) e regras de negócio com versões. |
| `brain_dependency_map` | `{ projectId }` | Mapa de dependências navegável entre serviços, módulos, regras de negócio e documentos. |
| `brain_onboarding_guide` | `{ projectId }` | Gera o guia de onboarding e convenções de arquitetura do projeto para novos desenvolvedores e agentes. |
| `brain_project_qa` | `{ projectId, question }` | Responde perguntas sobre o projeto com citações explícitas de regras, ADRs e código indexado. |
| `brain_tech_debt_radar` | `{ projectId }` | Painel de dívida técnica: calcula riscos, regras sem testes, decisões antigas e dependências frágeis. |

## 6. Topologia de Código (`tools/extended/code-topology.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_code_symbols_search` | `{ projectId, query, filePath }` | Busca símbolos de código indexados ou extrai símbolos AST de um arquivo local. |
| `brain_cross_service_register` | `{ projectId, serviceName, protocol, specContent, accessPolicyId }` | Registra um contrato OpenAPI / AsyncAPI / GraphQL / gRPC para análise cross-service. |
| `brain_export_topology_diagram` | `{ projectId, layer }` | Gera diagrama Mermaid e nós/arestas da topologia de conhecimento por camada. |
| `brain_ingest_git_repo` | `{ projectId, workspacePath, accessPolicyId, maxFiles }` | Indexa arquivos de conhecimento e código de um workspace local diretamente no Brain. |
| `brain_record_test_result` | `{ projectId, suiteName, testName, testItemId, commitSha, status, … }` | Registra resultado de execução de teste vinculado a regras de negócio. |
| `brain_update_knowledge` | `{ projectId, itemId, title, content, status }` | Atualiza ou arquiva/deprecia diretamente um item de conhecimento existente. |

## 7. Inteligência Diária e Memória (`tools/extended/daily-tools.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_explain_code` | `{ projectId, codeSnippet, filePath }` | Explicação de código contextualizada com as regras, ADRs e políticas ativas do projeto. |
| `brain_intent_search` | `{ projectId, query }` | Busca por intenção (ex: 'como publicar?', 'quem valida acesso?'), mesmo sem saber o nome exato dos arquivos. |
| `brain_internal_examples` | `{ projectId, pattern }` | Busca exemplos e padrões de implementação aprovados já resolvidos dentro do próprio repositório. |
| `brain_team_memory` | `{ projectId, action, teamId, agentId, title, content, … }` | Consulta e registra memórias e preferências de trabalho por equipe ou agente com controle de validade. |
| `brain_what_changed` | `{ projectId, period }` | Resumo das mudanças em código, regras, documentos e decisões de um projeto (ex: últimas 24 horas). |

## 8. Acesso, RBAC e Compartilhamento (`tools/extended/access-rbac.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_assign_user_roles` | `{ projectId, userId, roleIds, linkedAgentIds, inheritUserPermissions, extraPermissions, … }` | Atribui cargos a um usuário e vincula agentes que herdam integralmente todas as permissões do usuário (sem separação humano/IA). |
| `brain_delete_role` | `{ projectId }` | Remove um cargo customizado do projeto. |
| `brain_delete_user_policy` | `{ projectId, userId }` | Remove uma política granular de usuário e seus vínculos de delegação para agentes. |
| `brain_list_permissions_catalog` | `{}` | Lista todas as permissões disponíveis do sistema agrupadas por módulo (menus, conhecimento, propostas, runner, operação, cargos e permissões). |
| `brain_list_roles` | `{ projectId }` | Lista todos os cargos (padrão e customizados) e suas permissões e políticas associadas. |
| `brain_list_user_policies` | `{ projectId }` | Lista políticas granulares por usuário e os agentes vinculados que herdam permissões do usuário. |
| `brain_upsert_role` | `{ projectId, roleId, name, description, permissions, allowedPolicies }` | Cria ou atualiza um cargo com permissões variadas de menus, funções e políticas. |
| `brain_upsert_user_policy` | `{ projectId, userId, linkedAgentIds, inheritUserPermissions, roles, allowedActions, … }` | Cria ou atualiza via MCP uma política granular por usuário (papéis, ações, políticas, domínios, prefixos e agentes vinculados que herdam tudo que o usuário pode fazer). |

## 9. Brain Agent Runner — Operações (`tools/extended/runner-ops.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_acquire_lease` | `{ projectId, taskId, branch, targetFiles, ttlMinutes }` | Adquire ou renova um lease de tarefa/branch com lista de arquivos alvo e retorna conflitos existentes. |
| `brain_ask_human` | `{ projectId, taskId, question }` | Registra uma pergunta bloqueante vinculada a uma tarefa do Runner e pausa até resposta humana. |
| `brain_check_file_leases` | `{ projectId, targetFiles, excludeTaskId }` | Verifica se outros agentes ou desenvolvedores possuem leases ativos sobre os arquivos alvo. |
| `brain_context_feedback` | `{ projectId, sessionId, taskId, usefulItemIds, editedPaths }` | Registra feedback explícito de utilidade dos itens de um Context Pack para Context Hit Rate e CO_ACCESSED_WITH. |
| `brain_cross_service_blast_radius` | `{ projectId, contractId }` | Calcula o raio de explosão cross-service para alteração em um contrato ou serviço. |
| `brain_get_question_answer` | `{ projectId, taskId }` | Consulta perguntas pendentes e respostas humanas de uma tarefa do Brain Runner. |
| `brain_incident_to_code` | `{ projectId, incidentId, title, service, endpoint, tags }` | Correlaciona um incidente ou erro de produção com símbolos de código, serviços e regras de negócio. |
| `brain_list_proposals` | `{ projectId }` | Lista propostas pendentes ou com solicitação de revisão na fila de aprovações. |
| `brain_memory_recall` | `{ projectId, layer, limit }` | Consulta diretamente as camadas de memória (working, episodic, semantic, procedural, organizational). |
| `brain_pre_deploy_readiness` | `{ projectId, coveragePercent, minCoveragePercent, openCriticalIncidents, guardianPassed }` | Avalia prontidão pré-deploy (cobertura de regras, saúde do conhecimento, CVEs SBOM e incidentes). |
| `brain_revise_proposal` | `{ projectId, proposalId, title, content }` | Reenvia uma proposta após changes_requested, incrementando a versão para nova revisão humana. |
| `brain_runner_cancel` | `{ projectId, taskId }` | Cancela uma tarefa enfileirada ou em execução no Brain Runner. |
| `brain_runner_status` | `{ projectId, taskId }` | Consulta o status, resultado e consumo de modelo de uma tarefa delegada ao Brain Runner. |
| `brain_scaffold_recommendations` | `{ projectId, query }` | Retorna ADRs aprovados de referência e preferências do developer_profile para scaffold. |

## 10. Skills e Especificações (`tools/extended/skills-specs.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_get_skill` | `{ projectId, skillIdOrName }` | Carrega as instruções completas de uma Skill específica do projeto ou global (__org__) para o agente seguir. |
| `brain_list_skills` | `{ projectId, includeContent }` | Lista todas as Skills centralizadas (.brain/skills) do projeto e globais da organização (__org__) para agentes de IA. |
| `brain_upsert_knowledge_spec` | `{ projectId, id, title, type, content, summary, … }` | Cria ou atualiza uma Spec, Skill, Regra ou Documento no Hub de Conhecimento e Planejamento do projeto. |

## 11. Runner Admin, RBAC Estendido e Plugins/MCPs (`subagent-tools/runner-admin.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_access_manage` | `{ projectId, action, targetUserId, allowedProjects, allowedPolicies, roles }` | Consulta ou atualiza escopos de projetos, políticas e papéis de usuários (exige roles:view / users:assign_roles). |
| `brain_runner_delegate` | `{ projectId, instruction, targetRole, priority, maxSteps }` | Delega uma nova tarefa assíncrona ao Brain Runner (modelo principal ou submodelo) em modo draft-only. |
| `brain_runner_discuss` | `{ projectId, prompt, targetRole, mode, provider, model, … }` | Troca ideia com o Modelo Principal, com o Submodelo, ou coloca Principal <-> Submodelo para colaborar e tomar decisões. |
| `brain_runner_list` | `{ projectId, status, limit }` | Lista tarefas recentes do Brain Runner no projeto, com filtro opcional de status. |
| `brain_runner_mcps` | `{ projectId, action, serverId, name, transport, command, … }` | Lista, instala, ativa, desativa, testa, importa ou remove servidores MCP conectados ao Brain Runner. |
| `brain_runner_plugins` | `{ projectId, action, pluginId, name, description, source, … }` | Lista, instala, ativa, desativa, configura ou desinstala plugins conectados ao Brain Runner. |
| `brain_runner_providers` | `{ projectId, probe }` | Lista provedores configurados no Brain Runner e opcionalmente consulta modelos reais online. |
| `brain_runner_routing` | `{ projectId, primary, secondary, fallbacks }` | Consulta ou atualiza o Modelo Principal (primary), Submodelo (secondary) e fallbacks do Brain Runner. |

## 12. Subagentes — Ciclo de Vida, Leases e Agendamentos (`subagent-tools/lifecycle.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_graph_relate` | `{ projectId, fromItemId, toItemId, relationType, evidenceUri, confidence }` | Cria uma aresta explícita no grafo de conhecimento (ex.: VERIFIED_BY entre regra e teste, IMPLEMENTS, GOVERNED_BY, DEPENDS_ON). Aresta VERIFIED_BY atualiza o healthScore estrutural; a Matriz Corporativa exige ainda execução de teste 'passed'. |
| `brain_release_lease` | `{ projectId }` | Libera imediatamente o lease de tarefa/arquivos adquirido com brain_acquire_lease. |
| `brain_runner_retry` | `{ projectId, taskId, instructionOverride }` | Reenfileira uma tarefa do Brain Runner reaproveitando a instrução e prioridade originais. |
| `brain_runner_schedule_cancel` | `{ projectId, scheduleId }` | Cancela um agendamento recorrente do Brain Runner. |
| `brain_runner_schedule_create` | `{ projectId, instruction, cron, priority }` | Agenda uma execução recorrente do Brain Runner via expressão cron UTC. |
| `brain_runner_schedule_list` | `{ projectId }` | Lista os agendamentos recorrentes ativos do Brain Runner para o projeto. |
| `brain_subagent_artifacts` | `{ projectId }` | Lista saídas, handoffs e propostas associadas a uma tarefa do subagent. |
| `brain_subagent_usage` | `{ projectId }` | Consulta o consumo agregado de execuções, status e uso de modelos do Brain Runner no projeto. |
| `brain_subagent_verify` | `{ projectId, targetIds }` | Executa auditoria cruzada (arestas VERIFIED_BY no grafo, saúde das regras e prontidão de deploy) e retorna parecer estruturado. Nota: a Matriz Corporativa exige também execução de teste 'passed' (CI) além da aresta VERIFIED_BY. |

## 13. Subagentes — Mensageria, Modelos Locais e Inbox (`subagent-tools/messaging.ts`)

| Tool MCP | Parâmetros Principais | Descrição |
| :--- | :--- | :--- |
| `brain_answer_question` | `{ projectId, taskId, questionId, response, idempotencyKey }` | Responde a uma pergunta pendente aberta por um subagent via brain_ask_human e destrava a execução. |
| `brain_local_models_list` | `{ ollamaBaseUrl }` | Lista os modelos de IA baixados localmente no Ollama (ex.: gemma2:2b, gemma:2b, bge-m3) e status do serviço. |
| `brain_subagent_ask_local` | `{ projectId, prompt, model, intent, maxTokens, includeContext, … }` | Aciona um modelo local do Ollama (ex.: gemma2:2b) com o ContextPack do projeto para análises, resumos e rascunhos sem custo em nuvem. |
| `brain_subagent_logs` | `{ projectId, taskId }` | Consulta o progresso, mensagens enviadas, perguntas e metadados de execução de um subagent. |
| `brain_subagent_send_message` | `{ projectId, taskId, message }` | Envia uma mensagem ou correção de rota para uma execução/subagent do Brain Runner já em andamento. |
| `brain_subagent_triage_inbox` | `{ projectId, model, limit }` | Pré-analisa rascunhos e propostas pendentes na Caixa de Entrada, apontando conflitos com regras aprovadas e prioridade. |

## Resources e Prompts MCP (`resources-prompts.ts`)

**Resources (4):**

| URI Template | Conteúdo |
| :--- | :--- |
| `brain://projects/{projectId}/overview` | Visão geral do projeto (contagens, saúde do conhecimento) |
| `brain://projects/{projectId}/rules/active` | Regras de negócio ativas (`BR-*`) |
| `brain://projects/{projectId}/topology/{layer}` | Diagrama Mermaid da topologia por camada |
| `brain://projects/{projectId}/skills/{skillId}` | Conteúdo de uma skill oficial de engenharia |

**Prompts (3):** `brain-pre-change-check`, `brain-architecture-review`, `brain-handoff-summary`.
