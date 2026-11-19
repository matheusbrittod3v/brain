---
id: OPS-BRAIN-MCP-CATALOG
title: Catálogo de Tools, Resources e Prompts MCP do Brain
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Protocolo MCP no Brain

- **Descoberta & Sessão**: `brain_resolve_workspace_project`, `brain_list_projects`, `brain_whoami`, `brain_project_overview`, `brain_bootstrap_project`.
- **Busca & Topologia**: `brain_search`, `brain_context_build`, `brain_get_layered_knowledge`, `brain_export_topology_diagram`, `brain_find_related_code`, `brain_code_symbols_search`.
- **Ingestão & Mutação**: `brain_ingest_git_repo`, `brain_ingest_document`, `brain_ingest_knowledge`, `brain_update_knowledge`, `brain_graph_relate`, `brain_cross_service_register`.
- **Governança, Memória & FinOps**: `brain_validate_implementation`, `brain_analyze_change_impact`, `brain_record_learning`, `brain_memory_consolidate`, `brain_developer_profile_get/set`, `brain_finops_summary`, `brain_secret_scan`, `brain_enterprise_tech_radar`.
- **Resources (`brain://projects/{projectId}/...`)**: `overview`, `rules/active`, `topology/{layer}`, `skills/{skillId}`.
- **Prompts**: `brain-pre-change-check`, `brain-architecture-review`, `brain-handoff-summary`.
