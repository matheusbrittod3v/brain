# Claude Code Project Instructions

<!-- BRAIN:MCP:START -->
## Brain MCP — Uso Obrigatório & Conselheiro de Projeto

Quando o servidor MCP **brain** estiver disponível nesta sessão, **use-o sempre que possível** para economizar tokens, evitar retrabalho e manter o conhecimento atualizado:

1. **Início da tarefa**: chame `brain_resolve_workspace_project` para detectar o `projectId`, depois consulte `brain_context_build`, `brain_get_active_rules` e `brain_search` para aproveitar regras, topologias, contratos e decisões já prontas.
2. **Antes de concluir**: valide contra invariantes com `brain_validate_implementation`, avalie impacto com `brain_analyze_change_impact` e verifique segredos com `brain_secret_scan`.
3. **Ao finalizar**: atualize o Brain com `brain_ingest_git_repo` (se alterou `.brain/`), `brain_record_test_result`, `brain_record_learning` e `brain_create_handoff`.
<!-- BRAIN:MCP:END -->
