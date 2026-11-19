---
id: IMPLEMENTATION-PATTERNS
title: "Padrões de Implementação Aprovados no Repositório Brain"
status: approved
type: implementation_pattern
layer: code
access_policy: internal-project
tags:
  - layer:code
  - patterns
  - best-practices
  - architecture
---

# Padrões de Implementação Aprovados no Brain

Guia prático de desenvolvimento com exemplos canônicos para extensão de rotas, ferramentas MCP, componentes Vue e controle de cache.

## 1. Padrão de Nova Rota REST no Fastify

As rotas da API devem ser encapsuladas em funções tipadas `registerXRoutes(app: FastifyInstance, deps: Deps)`:

```typescript
import type { FastifyInstance } from "fastify";
import { authenticateRequest, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";

export function registerFeatureRoutes(app: FastifyInstance, deps: FeatureDeps) {
  app.post<{
    Params: { projectId: string };
    Body: { payload: string };
  }>("/v1/projects/:projectId/feature/action", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, deps.configuredApiKey, "default-org", deps.allowedProjects);
    if (!req.body.payload?.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Payload obrigatório.", 400);
    }
    return { success: true, processed: req.body.payload };
  });
}
```

## 2. Padrão de Nova Ferramenta MCP

Ao criar ferramentas no MCP Server, registre-as com Zod schema e descrição profilada:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";

export function registerTool(server: McpServer, ctx: AuthContext, profile: McpConnectionProfileName) {
  server.tool(
    "brain_custom_action",
    describeMcpTool(profile, "Executa uma ação no projeto respeitando RBAC."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      parameter: z.string().describe("Descrição do parâmetro")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      return okJson({ executed: true, projectId: pid });
    }
  );
}
```

## 3. Padrão de Componente Vue 3 (Nuxt 4) com useBrainApi

Utilizar o composable unificado `useBrainApi()` para consumir endpoints e emitir notificações automáticas:

```vue
<script setup lang="ts">
const props = defineProps<{ projectId: string }>()
const { apiFetch, notify } = useBrainApi()
const loading = ref(false)
const data = ref<any>(null)

async function loadData() {
  loading.value = true
  try {
    data.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/what-changed`)
  } catch (err) {
    notify('Erro', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}
</script>
```
