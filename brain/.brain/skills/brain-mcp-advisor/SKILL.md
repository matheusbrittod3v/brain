---
name: brain-mcp-advisor
description: Orienta agentes (Codex, Claude, Cursor, Antigravity) a sempre consultar e atualizar o MCP Brain antes e depois de tarefas no projeto, reutilizando regras, topologias, contratos, configurações dinâmicas e memórias.
---

# Brain MCP Advisor Skill

Sempre que o MCP ou plugin do **Brain** estiver disponível no projeto, siga este ciclo contínuo:

## 1. Antes de Implementar (Descoberta e Contexto)
1. **Identidade e Projetos**: chame `brain_whoami` e `brain_list_projects` para descobrir o `projectId` ativo e permissões CASL.
2. **Context Pack e Busca Híbrida**: chame `brain_get_context_pack` e `brain_search_knowledge` (HNSW `bge-m3` + BM25 + Grafo) para recuperar ADRs, regras de negócio (`BR-*`), contratos de API e padrões de código.
3. **Configurações Dinâmicas**: chame `brain_system_settings_get` para inspecionar parâmetros persistidos no PostgreSQL (`embeddings`, `runner`, `github`, `smtp`, `policies`) em vez de acoplar novas variáveis ao `.env`.
4. **Análise de Impacto**: antes de alterar schemas, rotas ou contratos, execute `brain_analyze_change_impact` e `brain_validate_cross_service_change`.

## 2. Centralização Obrigatória em `.brain/` (Sem pasta `docs/` e nada fora do projeto)
- **NUNCA crie ou use pasta `docs/`** (nem `doc/`, nem documentação, planos ou skills fora do projeto ou soltos na raiz).
- Tudo que seria colocado em `docs/` ou fora do projeto deve ser centralizado **exclusivamente dentro de `.brain/`** na raiz do projeto (`knowledgeRoot: ".brain/"`).
- **Ao iniciar um projeto novo**: se `.project-brain.json` e `.brain/` ainda não existirem na pasta do projeto, crie-os imediatamente antes de começar a codar e indexe via `brain_ingest_git_repo`.

## 3. Durante e Após a Implementação (Retroalimentação)
1. **Propor e Sincronizar Conhecimento**: documente novas decisões, regras, fluxos e contratos com `brain_propose_knowledge` e sincronize a pasta `.brain/` com `brain_sync_brain_folder`.
2. **Conectar o Grafo Semântico**: crie arestas rastreáveis (`implements`, `depends_on`, `governs`, `verifies`) usando `brain_link_knowledge`.
3. **Registrar Testes de Regras de Negócio**: sempre que criar ou executar testes que validam uma `BR-*`, registre a execução com `brain_record_test_result` para manter a cobertura QA em 100%.
4. **Memória Episódica e Handoff**: registre aprendizados técnicos com `brain_record_memory` e, ao delegar para subagentes ou encerrar etapas complexas, utilize `brain_runner_DynamicSubAgents` ou `brain_create_handoff`.
