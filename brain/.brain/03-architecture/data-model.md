---
id: ARCH-BRAIN-DATAMODEL
title: Modelo de Dados PostgreSQL 16 + pgvector + RLS
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: data
---

# Modelo de Dados Principal

```mermaid
erDiagram
  organizations ||--o{ projects : owns
  organizations ||--o{ auth_users : has
  projects ||--o{ knowledge_items : contains
  knowledge_items ||--o{ knowledge_embeddings : embeds
  knowledge_items ||--o{ knowledge_relations : links
  auth_users ||--o{ auth_mcp_tokens : issues
  projects ||--o{ runner_tasks : executes
  projects ||--o{ audit_logs : audits
```

- **RLS (Row-Level Security)**: `projects`, `knowledge_items`, `knowledge_relations`, `project_access_members` e `temporary_access_grants` usam `app.current_tenant_id`, `app.allowed_projects` e `app.allowed_policies`.
- **Busca Vetorial**: `knowledge_embeddings` armazena vetores `bge-m3` indexados via HNSW no `pgvector`.
