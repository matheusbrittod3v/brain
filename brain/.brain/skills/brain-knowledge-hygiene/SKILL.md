---
name: brain-knowledge-hygiene
description: Diretrizes para manter .brain/ atualizado, modular e sincronizado via MCP.
---

# Higiene de Conhecimento no Brain

1. Sempre chamar `brain_resolve_workspace_project` ao iniciar uma tarefa.
2. Consultar regras ativas (`brain_get_active_rules`) e contexto (`brain_context_build`) antes de editar código.
3. Registrar novas decisões arquiteturais em `.brain/03-architecture/`, regras em `.brain/01-business/business-rules/` e fluxos em `.brain/05-flows/` com diagramas Mermaid.
4. Após editar `.brain/`, reindexar via `brain_ingest_git_repo` e validar com `brain_project_overview`.
