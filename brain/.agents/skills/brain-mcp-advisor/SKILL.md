---
name: brain-mcp-advisor
description: >-
  Orienta agentes (Codex, Claude, Cursor, Antigravity) a sempre consultar e
  atualizar o MCP Brain antes e depois de tarefas no projeto, reutilizando
  regras, topologias, contratos, memórias e decisões já prontas.
---

# Brain MCP Advisor

Sempre que o servidor MCP **Brain** estiver conectado, use-o proativamente como fonte primária de contexto e memória do projeto:

## 1. Antes de explorar ou editar código
1. **Identifique o projeto automaticamente**: chame `brain_resolve_workspace_project` (ou `brain_list_projects` se necessário) para obter o `projectId` sem depender de IDs manuais.
2. **Busque conhecimento pronto**:
   - `brain_context_build` para montar o Context Pack da tarefa.
   - `brain_search` / `brain_get_layered_knowledge` para consultar arquitetura, regras de negócio, fluxos, código e dados já documentados.
   - `brain_get_active_rules` para conhecer invariantes e ADRs que governam o módulo.
   - `brain_export_topology_diagram` ou `brain://projects/{projectId}/topology/{layer}` para visualizar dependências em Mermaid.
3. **Verifique continuidade e locks**:
   - `brain_resume_handoff` para recuperar decisões da sessão anterior.
   - `brain_check_file_leases` / `brain_acquire_lease` antes de edições concorrentes.

## 2. Durante e antes de concluir mudanças
- `brain_validate_implementation` para validar mudanças contra regras e ADRs.
- `brain_analyze_change_impact` e `brain_cross_service_blast_radius` para medir impacto.
- `brain_secret_scan` antes de gravar ou commitar trechos sensíveis.

## 3. Após concluir a tarefa (manter o Brain vivo)
- `brain_ingest_git_repo` se criou/atualizou docs em `.brain/`.
- `brain_record_test_result` ao rodar testes vinculados a regras (`ruleIds`).
- `brain_record_learning` para registrar descobertas importantes (bugs, armadilhas, decisões).
- `brain_create_handoff` ao encerrar uma etapa longa para o próximo agente.
