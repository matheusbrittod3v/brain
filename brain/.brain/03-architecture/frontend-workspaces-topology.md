---
id: ARCH-BRAIN-FRONTEND
title: Topologia Modular da Web UI (Nuxt 4 + Nuxt UI)
type: architecture_decision
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# Arquitetura Modular do Frontend (`brain/apps/web`)

```mermaid
flowchart LR
  Index["pages/index.vue (Shell + Sidebar)"] --> Projects["ProjectsOverviewWorkspace"]
  Index --> Knowledge["KnowledgeHubWorkspace -> knowledge/*"]
  Index --> Search["SearchGraphWorkspace (HNSW + Grafo)"]
  Index --> Agents["AgentsRunnerWorkspace -> runner/*"]
  Index --> Ops["OperationsFinOpsWorkspace -> operations/*"]
  Index --> Access["AccessWorkspace -> access/*"]
  Index --> Profile["ProfileWorkspace -> profile/*"]
  OAuthPage["pages/auth/oauth.vue"] -->|OAuth 2.1 PKCE / Device Flow| API["API (:3333)"]
```

- **Pastas modulares**: `components/access/`, `components/knowledge/`, `components/operations/`, `components/profile/`, `components/runner/models/`, `components/runner/extensions/`.
- **Perfil & MCP**: `ProfileWorkspace.vue` centraliza `Conta & Permissões`, `OAuth2 IA & MCP` (aprovação 1-clique) e `Tokens MCP & Codex` (geração/revogação persistida no PostgreSQL).
