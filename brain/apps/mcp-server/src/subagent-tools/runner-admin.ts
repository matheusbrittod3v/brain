import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PROVIDER_REGISTRY,
  deleteRunnerMcpServer,
  fetchProviderLiveModels,
  generateWithVercelAiSdk,
  getProjectRouting,
  getStoredToken,
  importLocalMcpConfigs,
  installRunnerPlugin,
  listRunnerMcpServers,
  listRunnerPlugins,
  setProjectRouting,
  testRunnerMcpServer,
  uninstallRunnerPlugin,
  updateRunnerMcpServerStatus,
  updateRunnerPlugin,
  upsertRunnerMcpServer
} from "@brain/agent-runner";
import { assertPermission, assertProjectAccess, hasPermission, revokeActorSessions, usersStore, type AuthContext } from "@brain/auth";
import { describeMcpTool, type McpConnectionProfileName } from "../connection-profile.js";
import { okJson } from "../helpers.js";
import type { BrainRuntime } from "../runtime.js";

export function registerRunnerAdminTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  server.tool(
    "brain_runner_delegate",
    describeMcpTool(profile, "Delega uma nova tarefa assíncrona ao Brain Runner (modelo principal ou submodelo) em modo draft-only."),
    {
      projectId: z.string().min(1),
      instruction: z.string().min(1),
      targetRole: z.enum(["primary", "secondary"]).optional(),
      priority: z.enum(["low", "normal", "high"]).optional(),
      maxSteps: z.number().int().min(1).max(30).optional()
    },
    async ({ projectId, instruction, targetRole = "primary", priority = "normal", maxSteps }) => {
      assertProjectAccess(ctx, projectId);
      const taggedInstruction = targetRole === "secondary" ? `[role:secondary] ${instruction}` : instruction;
      const task = runtime.runner.enqueue(ctx, { projectId, instruction: taggedInstruction, priority, maxSteps });
      if (runtime.opRepo) {
        await runtime.opRepo.saveRunnerTask(ctx, task);
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task",
        targetId: task.taskId,
        metadata: { priority: task.priority, status: task.status }
      });
      return okJson({ projectId, task });
    }
  );

  server.tool(
    "brain_runner_list",
    describeMcpTool(profile, "Lista tarefas recentes do Brain Runner no projeto, com filtro opcional de status."),
    {
      projectId: z.string().min(1),
      status: z.enum(["all", "queued", "running", "awaiting_human", "completed", "escalated"]).optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    async ({ projectId, status = "all", limit = 25 }) => {
      assertProjectAccess(ctx, projectId);
      const allTasks = runtime.opRepo
        ? await runtime.opRepo.listRunnerTasks(ctx, projectId)
        : runtime.runner.listTasks(ctx, projectId);
      const filtered = status === "all" ? allTasks : allTasks.filter((t) => t.status === status);
      return okJson({
        projectId,
        count: filtered.slice(0, limit).length,
        tasks: filtered.slice(0, limit)
      });
    }
  );

  server.tool(
    "brain_runner_discuss",
    describeMcpTool(
      profile,
      "Troca ideia com o Modelo Principal, com o Submodelo, ou coloca Principal <-> Submodelo para colaborar e tomar decisões."
    ),
    {
      projectId: z.string().min(1),
      prompt: z.string().min(1),
      targetRole: z.enum(["primary", "secondary", "collaborate"]).optional(),
      mode: z.enum(["brainstorm", "review", "decide"]).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      includeContext: z.boolean().optional()
    },
    async ({ projectId, prompt, targetRole = "primary", mode = "brainstorm", provider, model, includeContext = true }) => {
      assertProjectAccess(ctx, projectId);
      let contextSnippet = "";
      if (includeContext) {
        try {
          const items = await runtime.retrieval.search(ctx, { projectId, query: prompt, limit: 6 });
          if (items.length > 0) {
            contextSnippet =
              "\n\nContexto autorizado do projeto:\n" +
              items.map((r) => `- [${r.item.type}] ${r.item.title}: ${r.item.content.slice(0, 300)}`).join("\n");
          }
        } catch {
          // Non-fatal
        }
      }

      const routing = getProjectRouting(ctx.tenantId, projectId);
      const modeInstruction =
        mode === "decide"
          ? "Analise as opções, recomende uma decisão clara e liste os trade-offs."
          : mode === "review"
            ? "Faça uma revisão crítica apontando riscos, lacunas e ajustes."
            : "Troque ideias de forma colaborativa, prática e objetiva.";

      const started = Date.now();
      if (targetRole === "collaborate") {
        const primaryDraft = await generateWithVercelAiSdk({
          provider: routing.primary.provider,
          model: routing.primary.model,
          apiKey: getStoredToken(routing.primary.provider),
          system: `Você é o Agente Principal (projeto '${projectId}'). ${modeInstruction}`,
          prompt: `${prompt}${contextSnippet}`,
          fallbacks: routing.fallbacks,
          timeoutMs: 90_000
        });
        const secondaryReview = await generateWithVercelAiSdk({
          provider: routing.secondary.provider,
          model: routing.secondary.model,
          apiKey: getStoredToken(routing.secondary.provider),
          system: `Você é o Submodelo / Agente Secundário (projeto '${projectId}'). Revise a análise do Agente Principal e aponte melhorias ou riscos.`,
          prompt: `Pergunta:\n${prompt}\n\nAnálise do Principal:\n${primaryDraft.text}`,
          timeoutMs: 60_000
        });
        const consolidated = await generateWithVercelAiSdk({
          provider: routing.primary.provider,
          model: routing.primary.model,
          apiKey: getStoredToken(routing.primary.provider),
          system: `Você é o Agente Principal (projeto '${projectId}'). Consolide a resposta final incorporando a revisão do Submodelo.`,
          prompt: `Pergunta:\n${prompt}\n\nSua análise:\n${primaryDraft.text}\n\nRevisão do Submodelo (${secondaryReview.provider}/${secondaryReview.model}):\n${secondaryReview.text}`,
          fallbacks: routing.fallbacks,
          timeoutMs: 90_000
        });
        return okJson({
          projectId,
          targetRole,
          mode,
          reply: consolidated.text,
          secondaryReply: secondaryReview.text,
          secondaryProvider: secondaryReview.provider || routing.secondary.provider,
          secondaryModel: secondaryReview.model || routing.secondary.model,
          provider: consolidated.provider || routing.primary.provider,
          model: consolidated.model || routing.primary.model,
          latencyMs: Date.now() - started
        });
      }

      const selected = targetRole === "secondary" ? routing.secondary : routing.primary;
      const targetProvider = provider?.trim() || selected.provider;
      const targetModel = model?.trim() || selected.model;

      const res = await generateWithVercelAiSdk({
        provider: targetProvider,
        model: targetModel,
        apiKey: getStoredToken(targetProvider),
        system: `Você é o Brain Runner (${targetRole === "secondary" ? "Submodelo" : "Modelo Principal"} · projeto '${projectId}'). ${modeInstruction}`,
        prompt: `${prompt}${contextSnippet}`,
        fallbacks: provider ? undefined : routing.fallbacks,
        timeoutMs: 90_000
      });

      return okJson({
        projectId,
        targetRole,
        mode,
        reply: res.text,
        provider: res.provider || targetProvider,
        model: res.model || targetModel,
        attempts: res.attempts ?? 1,
        usage: res.usage,
        latencyMs: Date.now() - started
      });
    }
  );

  server.tool(
    "brain_runner_routing",
    describeMcpTool(profile, "Consulta ou atualiza o Modelo Principal (primary), Submodelo (secondary) e fallbacks do Brain Runner."),
    {
      projectId: z.string().min(1),
      primary: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      secondary: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      fallbacks: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).optional()
    },
    async ({ projectId, primary, secondary, fallbacks }) => {
      assertProjectAccess(ctx, projectId);
      const current = getProjectRouting(ctx.tenantId, projectId);
      if (!primary && !secondary && !fallbacks) {
        return okJson({ projectId, routing: current });
      }
      const updated = setProjectRouting(ctx.tenantId, projectId, {
        primary: primary ?? current.primary,
        secondary: secondary ?? current.secondary,
        fallbacks: fallbacks ?? current.fallbacks
      });
      return okJson({ projectId, routing: updated });
    }
  );

  server.tool(
    "brain_runner_providers",
    describeMcpTool(profile, "Lista provedores configurados no Brain Runner e opcionalmente consulta modelos reais online."),
    {
      projectId: z.string().min(1),
      probe: z.boolean().optional()
    },
    async ({ projectId, probe = false }) => {
      assertProjectAccess(ctx, projectId);
      const specs = Object.values(PROVIDER_REGISTRY);
      const providers = await Promise.all(
        specs.map(async (spec) => {
          if (!probe) {
            return {
              id: spec.id,
              mode: spec.mode,
              hasFree: Boolean(spec.hasFree),
              configured: Boolean(getStoredToken(spec.id) || (spec.envKey ? process.env[spec.envKey] : undefined) || spec.defaultApiKey)
            };
          }
          const live = await fetchProviderLiveModels(spec.id, { apiKey: getStoredToken(spec.id), timeoutMs: 2000 });
          return {
            id: spec.id,
            mode: spec.mode,
            hasFree: Boolean(spec.hasFree),
            online: live.online,
            modelsCount: live.models.length,
            models: live.models.slice(0, 15).map((m) => m.id),
            error: live.error
          };
        })
      );
      return okJson({ projectId, providers });
    }
  );

  server.tool(
    "brain_runner_plugins",
    describeMcpTool(profile, "Lista, instala, ativa, desativa, configura ou desinstala plugins conectados ao Brain Runner."),
    {
      projectId: z.string().min(1),
      action: z.enum(["list", "install", "enable", "disable", "configure", "uninstall"]).default("list"),
      pluginId: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      source: z.enum(["builtin", "local", "npm", "git"]).optional(),
      sourceRef: z.string().optional(),
      config: z.record(z.string(), z.string()).optional(),
      env: z.record(z.string(), z.string()).optional()
    },
    async ({ projectId, action, pluginId, name, description, source, sourceRef, config, env }) => {
      assertProjectAccess(ctx, projectId);
      if (action === "list") {
        assertPermission(ctx, "runner:view");
        return okJson({ projectId, ...listRunnerPlugins(projectId) });
      }
      if (!hasPermission(ctx, "runner:plugin:manage") && !hasPermission(ctx, "runner:execute")) {
        assertPermission(ctx, "runner:plugin:manage");
      }
      if (!pluginId) throw new Error("pluginId é obrigatório para esta ação.");
      if (action === "install") {
        return okJson({
          projectId,
          plugin: installRunnerPlugin(projectId, { id: pluginId, name, description, source, sourceRef, config, env })
        });
      }
      if (action === "enable" || action === "disable") {
        return okJson({
          projectId,
          plugin: updateRunnerPlugin(projectId, pluginId, { enabled: action === "enable" })
        });
      }
      if (action === "configure") {
        return okJson({
          projectId,
          plugin: updateRunnerPlugin(projectId, pluginId, { config, env })
        });
      }
      return okJson({ projectId, removed: uninstallRunnerPlugin(projectId, pluginId) });
    }
  );

  server.tool(
    "brain_runner_mcps",
    describeMcpTool(profile, "Lista, instala, ativa, desativa, testa, importa ou remove servidores MCP conectados ao Brain Runner."),
    {
      projectId: z.string().min(1),
      action: z.enum(["list", "install", "enable", "disable", "test", "remove", "import_local"]).default("list"),
      serverId: z.string().optional(),
      name: z.string().optional(),
      transport: z.enum(["stdio", "http", "sse"]).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional()
    },
    async ({ projectId, action, serverId, name, transport, command, args, url, env, headers }) => {
      assertProjectAccess(ctx, projectId);
      if (action === "list") {
        assertPermission(ctx, "runner:view");
        return okJson({ projectId, ...listRunnerMcpServers(projectId) });
      }
      if (!hasPermission(ctx, "runner:mcp:manage") && !hasPermission(ctx, "runner:execute")) {
        assertPermission(ctx, "runner:mcp:manage");
      }
      if (action === "import_local") {
        return okJson({ projectId, ...importLocalMcpConfigs(projectId) });
      }
      if (!serverId) throw new Error("serverId é obrigatório para esta ação.");
      if (action === "install") {
        return okJson({
          projectId,
          server: upsertRunnerMcpServer(projectId, { id: serverId, name, transport, command, args, url, env, headers })
        });
      }
      if (action === "enable" || action === "disable") {
        return okJson({
          projectId,
          server: updateRunnerMcpServerStatus(projectId, serverId, action === "enable")
        });
      }
      if (action === "test") {
        return okJson({ projectId, serverId, result: await testRunnerMcpServer(projectId, serverId) });
      }
      return okJson({ projectId, removed: deleteRunnerMcpServer(projectId, serverId) });
    }
  );

  server.tool(
    "brain_access_manage",
    describeMcpTool(profile, "Consulta ou atualiza escopos de projetos, políticas e papéis de usuários (exige roles:view / users:assign_roles)."),
    {
      projectId: z.string().min(1),
      action: z.enum(["list_users", "update_scopes", "revoke_sessions"]).default("list_users"),
      targetUserId: z.string().optional(),
      allowedProjects: z.array(z.string()).optional(),
      allowedPolicies: z.array(z.string()).optional(),
      roles: z.array(z.string()).optional()
    },
    async ({ projectId, action, targetUserId, allowedProjects, allowedPolicies, roles }) => {
      assertProjectAccess(ctx, projectId);
      if (action === "list_users") {
        assertPermission(ctx, "roles:view");
        const users = usersStore.listUsers().map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          roles: u.roles,
          allowedProjects: u.allowedProjects,
          allowedPolicies: u.allowedPolicies
        }));
        return okJson({ projectId, users });
      }
      assertPermission(ctx, "users:assign_roles");
      if (!targetUserId) {
        throw new Error("targetUserId é obrigatório para esta ação.");
      }
      if (action === "revoke_sessions") {
        revokeActorSessions(targetUserId);
        return okJson({ projectId, targetUserId, revoked: true });
      }
      const user = usersStore.getUserById(targetUserId);
      if (!user) {
        throw new Error(`Usuário '${targetUserId}' não encontrado.`);
      }
      if (allowedProjects) user.allowedProjects = [...allowedProjects];
      if (allowedPolicies) user.allowedPolicies = [...allowedPolicies];
      if (roles) user.roles = [...roles];
      user.updatedAt = new Date().toISOString();
      revokeActorSessions(targetUserId);
      return okJson({
        projectId,
        targetUserId,
        allowedProjects: user.allowedProjects,
        allowedPolicies: user.allowedPolicies,
        roles: user.roles,
        sessionsRevoked: true
      });
    }
  );
}

