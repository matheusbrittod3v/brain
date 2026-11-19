---
name: brain-mcp-advisor
description: >-
  Guia 360° para agentes (Codex, Claude, Cursor, Antigravity) usarem o MCP Brain
  e manterem todo conhecimento multi-setor e multi-formato centralizado em .brain/.
---

# Brain MCP Advisor — Guia 360°

Sempre que o MCP **Brain** estiver conectado, use-o como workspace central de conhecimento, governança e memória do projeto:

## 1. Centralização Total em `.brain/` (Sem `docs/` e Workspace Universal)
- **NUNCA crie ou use pasta `docs/`** (nem `doc/`, planos, notas ou skills fora do projeto).
- Centralize **100% do conhecimento em `.brain/`** na raiz do projeto (`knowledgeRoot: ".brain/"`).
- **Suporte Universal (Setores, Arquiteturas e Formatos)**: `.brain/` aceita qualquer setor/pasta (`00-overview/`, `01-business/`, `02-onboarding/`, `03-architecture/`, `04-engineering/`, `05-flows/`, `06-operations/`, `skills/`, `specs/`, `tests/`, `marketing/`, `produto/`, `design/`, `dados/`, `juridico/`, `financeiro/`, `clientes/`, `infra/`, `pesquisa/`) e qualquer formato (`.md`, `.yaml`, `.yml`, `.json`, `.jsonl`, `.txt`, `.csv`, `.mmd`/`.mermaid`, `.sql`, `.toml`, `.html`, `.rst`, `.adoc`, `.graphql`, `.proto`).
- **Ao iniciar um projeto novo**: se `.project-brain.json` e `.brain/` não existirem, crie-os imediatamente e chame `brain_resolve_workspace_project({ workspacePath, createIfMissing: true })`.

## 2. Casos de Uso & Recursos (Visão 360°)
- **Antes de implementar**:
  - `brain_resolve_workspace_project` -> `brain_context_build` -> `brain_get_active_rules` -> `brain_search` -> `brain_memory_recall` -> `brain_list_skills`.
  - `brain_system_settings_get` para consultar configurações dinâmicas no PostgreSQL sem acoplar ao `.env`.
  - **Projetos Globais (`isShared=true`)**: `brain_list_shared_projects()` e consulta direta pelo `projectId` global (ou `includeShared: true` em `brain_search`), sem misturar dados em projetos isolados.
  - **Resources MCP**: `brain://projects/{projectId}/overview`, `brain://projects/{projectId}/rules`, `brain://projects/{projectId}/topology/{layer}`.
- **Durante mudanças & arquitetura**:
  - `brain_analyze_change_impact`, `brain_cross_service_blast_radius`, `brain_contradiction_detect`, `brain_validate_implementation`, `brain_export_topology_diagram`, `brain_secret_scan`, `brain_check_file_leases` / `brain_acquire_lease`.
- **Após implementar (retroalimentação)**:
  - `brain_ingest_git_repo` / `brain_ingest_document` após editar `.brain/`.
  - `brain_graph_relate` (`VERIFIED_BY`, `IMPLEMENTS`, `GOVERNED_BY`, `DEPENDS_ON`).
  - `brain_record_test_result` para manter 100% de cobertura QA, `brain_record_learning` e `brain_create_handoff` / `brain_resume_handoff`.
