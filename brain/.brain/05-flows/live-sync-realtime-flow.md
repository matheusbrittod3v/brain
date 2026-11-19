---
id: FLOW-BRAIN-LIVE-SYNC
title: Sincronização Dinâmica em Tempo Real (Live Sync) Sem F5
type: process
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Sincronização Dinâmica em Tempo Real (Live Sync) Sem F5

**Entrypoint:** `useBrainApi().liveSyncTick`

## Ciclo de Vida por Camada

1. **[frontend]** `useBrainApi.apiFetch (POST/PUT/PATCH/DELETE)` (`apps/web/app/composables/useBrainApi.ts`) — In: Requisição de mutação bem-sucedida | Out: Incrementa liveSyncTick.value
2. **[frontend]** `WorkspaceTabs (CodeFlows, Overview, Audit, Graph).watch([projectId, liveSyncTick], reload)` (`apps/web/app/components/knowledge/CodeFlowsTab.vue`) — In: Novo valor de liveSyncTick | Out: Re-fetch silencioso dos endpoints GET
3. **[api]** `Fastify Routes.GET /v1/projects/:projectId/*` (`apps/api/src/server.ts`) — In: AuthContext + projectId | Out: Estado atualizado do banco
4. **[database]** `PostgreSQL.SELECT com RLS` (`packages/storage/src/schema.ts`) — In: tenant_id, project_id | Out: Dados frescos sem cache obsoleto

## Diagrama Mermaid

```mermaid
flowchart TD
  S1["1. frontend useBrainApi.apiFetch (POST/PUT/PATCH/DELETE)"]
  S2["2. frontend WorkspaceTabs (CodeFlows, Overview, Audit, Graph).watch(projectId, liveSyncTick, reload)"]
  S3["3. api Fastify Routes.GET /v1/projects/:projectId/*"]
  S4["4. database PostgreSQL.SELECT com RLS"]
  S1 --> S2
  S2 --> S3
  S3 --> S4
```
