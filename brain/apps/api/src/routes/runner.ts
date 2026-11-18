import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  PROVIDER_REGISTRY,
  completeProviderOAuth,
  disconnectProviderConnection,
  fetchProviderLiveModels,
  generateWithVercelAiSdk,
  getProjectRouting,
  getStoredConnection,
  getStoredToken,
  importLocalProviderAuth,
  listProviderModels,
  registerCustomModel,
  registerLlmProvider,
  removeCustomModel,
  saveApiKeyConnection,
  setModelDisabled,
  setProjectRouting,
  startProviderOAuth,
  supportsProviderOAuth,
  type BrainRunnerQueue,
  type LlmFallbackTarget,
  type ModelCatalogItem,
  type ProviderSpec
} from "@brain/agent-runner";
import type { AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgOperationalRepository } from "@brain/database";
import { cancelRunnerSchedule, listRunnerSchedules } from "@brain/mcp-server";

export function registerRunnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    runner: BrainRunnerQueue;
    opRepo?: PgOperationalRepository;
  }
) {
  const {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    runner,
    opRepo
  } = deps;

  app.post<{ Params: { projectId: string }; Body: { instruction: string; priority?: "low" | "normal" | "high" } }>(
    "/v1/projects/:projectId/runner/tasks",
    { schema: { body: Type.Object({ instruction: Type.String(), priority: Type.Optional(Type.String()) }) } },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const task = runner.enqueue(ctx, { projectId: req.params.projectId, instruction: req.body.instruction, priority: req.body.priority });
      if (opRepo) await opRepo.saveRunnerTask(ctx, task);
      return task;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/schedules", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
    const schedules = await listRunnerSchedules({ tenantId: ctx.tenantId, projectId: req.params.projectId }, databaseUrl);
    return { schedules };
  });

  app.delete<{ Params: { projectId: string; scheduleId: string } }>(
    "/v1/projects/:projectId/runner/schedules/:scheduleId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
      const cancelled = await cancelRunnerSchedule({ tenantId: ctx.tenantId, projectId: req.params.projectId }, req.params.scheduleId, databaseUrl);
      if (!cancelled) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Schedule '${req.params.scheduleId}' não encontrado.`, 404);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "revoke",
        targetType: "runner_schedule",
        targetId: req.params.scheduleId,
        metadata: {}
      });
      return { scheduleId: req.params.scheduleId, cancelled: true };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/tasks", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const tasks = opRepo ? await opRepo.listRunnerTasks(ctx, req.params.projectId) : runner.listTasks(ctx, req.params.projectId);
    const pendingQuestions = opRepo
      ? await opRepo.listPendingRunnerQuestions(ctx, req.params.projectId)
      : runner.listPendingQuestions(ctx, req.params.projectId);
    const questionByTask = new Map(pendingQuestions.map((question) => [question.taskId, question]));
    return {
      tasks: tasks.map((task) => {
        const pendingQuestion = questionByTask.get(task.taskId);
        return pendingQuestion
          ? { ...task, pendingQuestion: { questionId: pendingQuestion.questionId, question: pendingQuestion.question } }
          : task;
      })
    };
  });

  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/cancel",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (opRepo) {
        const cancelled = await opRepo.cancelRunnerTask(ctx, req.params.projectId, req.params.taskId);
        if (!cancelled) {
          throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`, 409);
        }
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "revoke",
          targetType: "runner_task",
          targetId: req.params.taskId,
          metadata: { status: "cancelled" }
        });
        return cancelled;
      }
      const task = runner.getTask(ctx, req.params.taskId);
      if (!task || task.projectId !== req.params.projectId || !["queued", "waiting_human", "escalated"].includes(task.status)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`, 409);
      }
      task.status = "cancelled" as typeof task.status;
      task.resultSummary = "Cancelada pelo operador.";
      return task;
    }
  );

  app.post<{ Params: { projectId: string; taskId: string }; Body: { question: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/questions",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
        body: Type.Object({ question: Type.String({ minLength: 1 }) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const questionText = req.body.question.trim();
      if (!questionText) throw new BrainError("BRAIN_ERR_CONFLICT", "A pergunta não pode estar vazia.", 400);
      const question = opRepo
        ? await opRepo.createRunnerQuestion(ctx, {
            questionId: randomUUID(),
            projectId: req.params.projectId,
            taskId: req.params.taskId,
            question: questionText,
            accessPolicyId: "internal-project"
          })
        : runner.askQuestion(ctx, req.params.taskId, questionText);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task_question",
        targetId: question.questionId,
        metadata: { taskId: req.params.taskId }
      });
      return { questionId: question.questionId, taskId: req.params.taskId, question: question.question, status: question.status };
    }
  );

  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/questions",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const questions = opRepo
        ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
        : runner.listQuestions(ctx, req.params.taskId);
      return { questions };
    }
  );

  // ---------------------------------------------------------------------------
  // 9Router-inspired Provider & Routing Management for Runner Frontend
  // ---------------------------------------------------------------------------
  const runtimeApiKeys = new Map<string, string>();

  const categorizeProvider = (spec: ProviderSpec): "local" | "cloud" | "gateway" | "cli" => {
    if (spec.mode === "cli") return "cli";
    if (["codex", "claude", "github", "9router", "cliproxy", "openai-compatible"].includes(spec.id)) return "gateway";
    if (["ollama", "lmstudio", "llamacpp", "vllm", "localai"].includes(spec.id)) return "local";
    return "cloud";
  };

  const liveModelsCache = new Map<string, { online: boolean; models: ModelCatalogItem[]; error?: string }>();

  const buildProviderModels = (providerId: string, live?: { online: boolean; models: ModelCatalogItem[]; error?: string }): ModelCatalogItem[] => {
    const catalog = listProviderModels(providerId);
    const catalogMap = new Map(catalog.map((m) => [m.id, m]));
    const result = new Map<string, ModelCatalogItem>();

    // 1. Real live models fetched directly from the provider connection
    if (live?.online) {
      for (const m of live.models) {
        const existing = catalogMap.get(m.id);
        result.set(m.id, {
          ...m,
          disabled: existing?.disabled ?? false,
          custom: existing?.custom ?? false
        });
      }
    }

    // 2. User-registered custom models always stay visible
    for (const m of catalog) {
      if (m.custom && !result.has(m.id)) {
        result.set(m.id, m);
      }
    }

    return Array.from(result.values());
  };

  app.get<{ Params: { projectId: string }; Querystring: { probe?: string } }>(
    "/v1/projects/:projectId/runner/providers",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const shouldProbe = req.query.probe !== "false";
      const specs = Object.values(PROVIDER_REGISTRY);
      const providers = await Promise.all(
        specs.map(async (spec) => {
          const stored = getStoredConnection(spec.id);
          const hasApiKey = Boolean(
            runtimeApiKeys.get(spec.id) ||
              getStoredToken(spec.id) ||
              (spec.envKey ? process.env[spec.envKey] : undefined) ||
              spec.defaultApiKey
          );
          const category = categorizeProvider(spec);
          let live = liveModelsCache.get(spec.id);
          if (shouldProbe) {
            const fetched = await fetchProviderLiveModels(spec.id, {
              apiKey: runtimeApiKeys.get(spec.id) || getStoredToken(spec.id),
              timeoutMs: 2200
            });
            live = { online: fetched.online, models: fetched.models, error: fetched.error };
            liveModelsCache.set(spec.id, live);
          }
          const models = buildProviderModels(spec.id, live);
          return {
            id: spec.id,
            mode: spec.mode,
            format: spec.format,
            category,
            hasFree: Boolean(spec.hasFree || category === "local"),
            supportsOAuth: supportsProviderOAuth(spec.id),
            supportsLocalImport: ["codex", "claude", "gemini-cli"].includes(spec.id),
            connectedAccount: stored
              ? {
                  authType: stored.authType,
                  email: stored.email,
                  planType: stored.planType,
                  updatedAt: stored.updatedAt
                }
              : undefined,
            baseUrl: stored?.baseUrl || spec.baseUrl,
            envKey: spec.envKey,
            cliCommand: spec.cliCommand,
            configured: spec.mode === "cli" ? Boolean(live?.online) : hasApiKey,
            online: Boolean(live?.online),
            connectionError: live?.error,
            discoveredModels: live?.online ? live.models.map((m) => m.id) : [],
            models
          };
        })
      );
      return { providers };
    }
  );

  app.get<{ Params: { projectId: string; providerId: string } }>(
    "/v1/projects/:projectId/runner/providers/:providerId/models",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const fetched = await fetchProviderLiveModels(req.params.providerId, {
        apiKey: runtimeApiKeys.get(req.params.providerId),
        timeoutMs: 4000
      });
      const live = { online: fetched.online, models: fetched.models, error: fetched.error };
      liveModelsCache.set(req.params.providerId, live);
      return {
        provider: req.params.providerId,
        online: fetched.online,
        error: fetched.error,
        models: buildProviderModels(req.params.providerId, live)
      };
    }
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/runner/routing",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      return getProjectRouting(ctx.tenantId, req.params.projectId);
    }
  );

  app.put<{
    Params: { projectId: string };
    Body: {
      primary: LlmFallbackTarget;
      secondary?: LlmFallbackTarget;
      fallbacks?: LlmFallbackTarget[];
      providerConfig?: {
        id: string;
        mode?: "http" | "cli";
        baseUrl?: string;
        apiKey?: string;
        cliCommand?: string[];
      };
    };
  }>(
    "/v1/projects/:projectId/runner/routing",
    {
      schema: {
        body: Type.Object({
          primary: Type.Object({
            provider: Type.String({ minLength: 1 }),
            model: Type.String({ minLength: 1 }),
            baseUrl: Type.Optional(Type.String())
          }),
          secondary: Type.Optional(
            Type.Object({
              provider: Type.String({ minLength: 1 }),
              model: Type.String({ minLength: 1 }),
              baseUrl: Type.Optional(Type.String())
            })
          ),
          fallbacks: Type.Optional(
            Type.Array(
              Type.Object({
                provider: Type.String({ minLength: 1 }),
                model: Type.String({ minLength: 1 }),
                baseUrl: Type.Optional(Type.String())
              })
            )
          ),
          providerConfig: Type.Optional(
            Type.Object({
              id: Type.String({ minLength: 1 }),
              mode: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("cli")])),
              baseUrl: Type.Optional(Type.String()),
              apiKey: Type.Optional(Type.String()),
              cliCommand: Type.Optional(Type.Array(Type.String()))
            })
          )
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });

      if (req.body.providerConfig) {
        const cfg = req.body.providerConfig;
        const existing = PROVIDER_REGISTRY[cfg.id];
        registerLlmProvider(cfg.id, {
          mode: cfg.mode || existing?.mode || "http",
          format: existing?.format || "openai-compatible",
          baseUrl: cfg.baseUrl ?? existing?.baseUrl,
          envKey: existing?.envKey,
          defaultApiKey: existing?.defaultApiKey,
          headers: existing?.headers,
          cliCommand: cfg.cliCommand ?? existing?.cliCommand
        });
        if (cfg.apiKey?.trim()) {
          runtimeApiKeys.set(cfg.id, cfg.apiKey.trim());
          saveApiKeyConnection(cfg.id, cfg.apiKey.trim(), cfg.baseUrl);
          if (existing?.envKey) {
            process.env[existing.envKey] = cfg.apiKey.trim();
          }
        }
        liveModelsCache.delete(cfg.id);
      }

      return setProjectRouting(ctx.tenantId, req.params.projectId, {
        primary: req.body.primary,
        secondary: req.body.secondary,
        fallbacks: req.body.fallbacks
      });
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { provider: string; model: string; baseUrl?: string; apiKey?: string; cliCommand?: string[] };
  }>(
    "/v1/projects/:projectId/runner/providers/test",
    {
      schema: {
        body: Type.Object({
          provider: Type.String({ minLength: 1 }),
          model: Type.String({ minLength: 1 }),
          baseUrl: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
          cliCommand: Type.Optional(Type.Array(Type.String()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const started = Date.now();
      try {
        const res = await generateWithVercelAiSdk({
          provider: req.body.provider,
          model: req.body.model,
          baseUrl: req.body.baseUrl,
          apiKey: req.body.apiKey || runtimeApiKeys.get(req.body.provider),
          cliCommand: req.body.cliCommand,
          prompt: "Reply with OK.",
          timeoutMs: 15_000
        });
        return {
          ok: true,
          latencyMs: Date.now() - started,
          provider: res.provider || req.body.provider,
          model: res.model || req.body.model,
          preview: res.text.slice(0, 120)
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { provider: string; modelId: string; name?: string; free?: boolean };
  }>(
    "/v1/projects/:projectId/runner/models",
    {
      schema: {
        body: Type.Object({
          provider: Type.String({ minLength: 1 }),
          modelId: Type.String({ minLength: 1 }),
          name: Type.Optional(Type.String()),
          free: Type.Optional(Type.Boolean())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const created = registerCustomModel(req.body.provider, {
        id: req.body.modelId.trim(),
        name: req.body.name?.trim() || undefined,
        free: req.body.free
      });
      return { model: created };
    }
  );

  app.delete<{
    Params: { projectId: string };
    Body: { provider: string; modelId: string };
  }>(
    "/v1/projects/:projectId/runner/models",
    {
      schema: {
        body: Type.Object({
          provider: Type.String({ minLength: 1 }),
          modelId: Type.String({ minLength: 1 })
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const removed = removeCustomModel(req.body.provider, req.body.modelId);
      return { removed };
    }
  );

  app.patch<{
    Params: { projectId: string };
    Body: { provider: string; modelId: string; disabled: boolean };
  }>(
    "/v1/projects/:projectId/runner/models/toggle",
    {
      schema: {
        body: Type.Object({
          provider: Type.String({ minLength: 1 }),
          modelId: Type.String({ minLength: 1 }),
          disabled: Type.Boolean()
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const model = setModelDisabled(req.body.provider, req.body.modelId, req.body.disabled);
      return { model };
    }
  );

  app.post<{ Params: { projectId: string }; Body: { providerId?: string } }>(
    "/v1/projects/:projectId/runner/connections/import-local",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const imported = importLocalProviderAuth(req.body?.providerId);
      for (const item of imported) {
        liveModelsCache.delete(item.provider);
      }
      return {
        imported: imported.map((c) => ({
          provider: c.provider,
          authType: c.authType,
          email: c.email,
          planType: c.planType
        }))
      };
    }
  );

  app.post<{ Params: { projectId: string; providerId: string }; Body: { redirectUri?: string } }>(
    "/v1/projects/:projectId/runner/connections/:providerId/oauth/start",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      return startProviderOAuth(req.params.providerId, req.body?.redirectUri);
    }
  );

  app.post<{
    Params: { projectId: string; providerId: string };
    Body: { codeOrUrl?: string; state?: string; deviceCode?: string };
  }>(
    "/v1/projects/:projectId/runner/connections/:providerId/oauth/complete",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const result = await completeProviderOAuth(
        req.params.providerId,
        req.body?.codeOrUrl || "",
        req.body?.state,
        req.body?.deviceCode
      );
      if (result.connection) {
        liveModelsCache.delete(req.params.providerId);
      }
      return {
        pending: Boolean(result.pending),
        connection: result.connection
          ? {
              provider: result.connection.provider,
              authType: result.connection.authType,
              email: result.connection.email,
              planType: result.connection.planType
            }
          : undefined
      };
    }
  );

  app.delete<{ Params: { projectId: string; providerId: string } }>(
    "/v1/projects/:projectId/runner/connections/:providerId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const removed = disconnectProviderConnection(req.params.providerId);
      runtimeApiKeys.delete(req.params.providerId);
      liveModelsCache.delete(req.params.providerId);
      return { disconnected: removed };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
      role?: "primary" | "secondary" | "collaborate";
      provider?: string;
      model?: string;
      system?: string;
    };
  }>(
    "/v1/projects/:projectId/runner/chat",
    {
      schema: {
        body: Type.Object({
          messages: Type.Array(
            Type.Object({
              role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]),
              content: Type.String({ minLength: 1 })
            }),
            { minItems: 1 }
          ),
          role: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("secondary"), Type.Literal("collaborate")])),
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          system: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });

      const routing = getProjectRouting(ctx.tenantId, req.params.projectId);
      const role = req.body.role || "primary";
      const historyText = req.body.messages
        .slice(-16)
        .map((m) => `${m.role === "user" ? "Usuário" : m.role === "assistant" ? "Assistente" : "Sistema"}: ${m.content}`)
        .join("\n\n");

      const started = Date.now();
      if (role === "collaborate") {
        // 1. Primary creates an initial analysis/proposal
        const primaryDraft = await generateWithVercelAiSdk({
          provider: routing.primary.provider,
          model: routing.primary.model,
          apiKey: runtimeApiKeys.get(routing.primary.provider) || getStoredToken(routing.primary.provider),
          system: `Você é o Agente Principal (projeto '${req.params.projectId}'). Elabore uma análise inicial clara e objetiva para ser revisada pelo Submodelo.`,
          prompt: historyText,
          fallbacks: routing.fallbacks,
          timeoutMs: 90_000
        });
        // 2. Secondary (submodel) reviews & complements
        const secondaryReview = await generateWithVercelAiSdk({
          provider: routing.secondary.provider,
          model: routing.secondary.model,
          apiKey: runtimeApiKeys.get(routing.secondary.provider) || getStoredToken(routing.secondary.provider),
          system: `Você é o Submodelo / Agente Secundário (projeto '${req.params.projectId}'). Revise a análise do Agente Principal, aponte riscos, lacunas ou melhorias rápidas.`,
          prompt: `Pergunta do usuário:\n${historyText}\n\nAnálise do Principal:\n${primaryDraft.text}`,
          timeoutMs: 60_000
        });
        // 3. Primary consolidates final decision
        const consolidated = await generateWithVercelAiSdk({
          provider: routing.primary.provider,
          model: routing.primary.model,
          apiKey: runtimeApiKeys.get(routing.primary.provider) || getStoredToken(routing.primary.provider),
          system: `Você é o Agente Principal (projeto '${req.params.projectId}'). Consolide a resposta final incorporando os pontos válidos do Submodelo.`,
          prompt: `Pergunta:\n${historyText}\n\nSua análise inicial:\n${primaryDraft.text}\n\nRevisão do Submodelo (${secondaryReview.provider}/${secondaryReview.model}):\n${secondaryReview.text}`,
          fallbacks: routing.fallbacks,
          timeoutMs: 90_000
        });
        return {
          reply: consolidated.text,
          secondaryReply: secondaryReview.text,
          secondaryProvider: secondaryReview.provider || routing.secondary.provider,
          secondaryModel: secondaryReview.model || routing.secondary.model,
          provider: consolidated.provider || routing.primary.provider,
          model: consolidated.model || routing.primary.model,
          attempts: consolidated.attempts ?? 1,
          usage: {
            inputTokens: primaryDraft.usage.inputTokens + secondaryReview.usage.inputTokens + consolidated.usage.inputTokens,
            outputTokens: primaryDraft.usage.outputTokens + secondaryReview.usage.outputTokens + consolidated.usage.outputTokens,
            totalTokens: primaryDraft.usage.totalTokens + secondaryReview.usage.totalTokens + consolidated.usage.totalTokens
          },
          latencyMs: Date.now() - started
        };
      }

      const selected = role === "secondary" ? routing.secondary : routing.primary;
      const targetProvider = req.body.provider?.trim() || selected.provider;
      const targetModel = req.body.model?.trim() || selected.model;

      const res = await generateWithVercelAiSdk({
        provider: targetProvider,
        model: targetModel,
        apiKey: runtimeApiKeys.get(targetProvider) || getStoredToken(targetProvider),
        system:
          req.body.system?.trim() ||
          `Você é o Brain Chat (${role === "secondary" ? "Submodelo" : "Modelo Principal"} · projeto '${req.params.projectId}'). Responda de forma clara, prática e direta em Markdown.`,
        prompt: historyText,
        fallbacks: req.body.provider ? undefined : routing.fallbacks,
        timeoutMs: 90_000
      });

      return {
        reply: res.text,
        provider: res.provider || targetProvider,
        model: res.model || targetModel,
        attempts: res.attempts ?? 1,
        usage: res.usage,
        latencyMs: Date.now() - started
      };
    }
  );
}
