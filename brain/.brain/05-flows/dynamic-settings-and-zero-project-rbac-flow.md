---
id: FLOW-BRAIN-SETTINGS-RBAC
type: process
title: Fluxo de Configurações Dinâmicas (system_settings) e RBAC Sem Projeto (__global__)
domainId: 5
status: approved
owner: platform-architecture
accessPolicyId: internal-project
tags:
  - flow
  - system-settings
  - rbac
  - casl
  - zero-project
---

# Fluxo de Configurações Dinâmicas (`system_settings`) e RBAC Sem Projeto (`__global__`)

## 1. Ciclo de Vida de `system_settings` (Seed, Leitura Mascarada e Atualização)

```mermaid
sequenceDiagram
  autonumber
  participant Admin as Admin (Web UI / MCP)
  participant API as Fastify API (:3333)
  participant Repo as PgSystemSettingsRepository
  participant DB as PostgreSQL (system_settings)

  API->>Repo: ensureTable() + seedDefaultsIfEmpty("default-org")
  Repo->>DB: INSERT ... ON CONFLICT DO NOTHING (16 parâmetros iniciais)
  Admin->>API: GET /v1/system/settings (ou brain_system_settings_get)
  API->>Repo: listSettings(tenantId, category, maskSecrets=true)
  Repo->>DB: SELECT * FROM system_settings WHERE tenant_id = $1
  Repo-->>API: Segredos (isSecret=true) mascarados como "••••••••"
  API-->>Admin: { items: [...] }

  Admin->>API: PUT /v1/system/settings { category, key, value, isSecret }
  API->>API: Valida role (admin | owner | tech-lead)
  API->>Repo: upsertSetting(tenantId, category, key, value, isSecret, actorId)
  Repo->>DB: INSERT ... ON CONFLICT (tenant_id, category, key) DO UPDATE
  API-->>Admin: Configuração persistida + evento gravado em audit_logs
```

## 2. Fluxo de Desvinculação de Projetos e Acesso Global CASL (`__global__`)

```mermaid
sequenceDiagram
  autonumber
  participant User as Usuário Sem Projeto (allowedProjects=[])
  participant Web as Nuxt 4 Studio (:3000)
  participant API as Fastify API (:3333)
  participant DB as PostgreSQL (auth_users / projects)

  User->>Web: Login (POST /v1/auth/login)
  Web->>API: GET /v1/auth/me
  API->>DB: findUserById(actorId) -> allowedProjects: []
  API-->>Web: 200 OK { allowedProjects: [], roles: [...], permissions: [...] }

  Web->>API: GET /v1/projects
  API-->>Web: { projects: [] } (Topbar exibe "Sem projeto vinculado")

  User->>Web: Abre guia "Acesso, CASL & Políticas"
  Web->>API: GET /v1/projects/__global__/access/users, /roles, /permissions
  API->>API: authenticateProjectRequest(token, "__global__") -> valida CASL sem exigir projeto
  API-->>Web: { users: [...], roles: DEFAULT_ROLES, permissions: PERMISSION_CATALOG }

  User->>Web: Abre modal "Escopos & Projetos" (ScopeModal)
  Web->>API: GET /v1/projects?scope=catalog
  API->>DB: SELECT * FROM projects WHERE tenant_id = 'default-org'
  API-->>Web: Lista projetos existentes (ex.: ["brain"]) como tags clicáveis
```
