import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { resolveActiveFinopsDowngrade } from "../../services/finops-quota.js";
import {
  PROVIDER_REGISTRY,
  completeProviderOAuth,
  disconnectProviderConnection,
  fetchProviderLiveModels,
  generateWithVercelAiSdk,
  getOAuthStateStatus,
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
  type LlmFallbackTarget,
  type ModelCatalogItem,
  type ProviderSpec
} from "@brain/agent-runner";
import { assertSafeExternalUrl, type RunnerRouteDeps, type RunnerSharedState } from "./security.js";

function categorizeProvider(spec: ProviderSpec): "local" | "cloud" | "gateway" | "cli" {
  if (spec.mode === "cli") return "cli";
  if (["antigravity", "codex", "claude", "github", "kimi-coding", "qwen", "iflow", "9router", "cliproxy", "openai-compatible"].includes(spec.id)) return "gateway";
  if (["ollama", "lmstudio", "llamacpp", "vllm", "localai"].includes(spec.id)) return "local";
  return "cloud";
}

function buildProviderModels(providerId: string, live?: { online: boolean; models: ModelCatalogItem[]; error?: string }): ModelCatalogItem[] {
  const catalog = listProviderModels(providerId);
  const catalogMap = new Map(catalog.map((m) => [m.id, m]));
  const result = new Map<string, ModelCatalogItem>();

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

  for (const m of catalog) {
    if (m.custom && !result.has(m.id)) {
      result.set(m.id, m);
    }
  }

  return Array.from(result.values());
}

export function registerRunnerProviderRoutes(
  app: FastifyInstance,
  deps: RunnerRouteDeps,
  state: RunnerSharedState
) {
  const { authenticateProjectRequest, enforcePolicy, opRepo, projectModelUsage } = deps;
  const { runtimeApiKeys, liveModelsCache } = state;

  app.get<{ Params: { projectId: string }; Querystring: { probe?: string } }>(
    "/v1/projects/:projectId/runner/providers",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
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
            supportsLocalImport: ["codex", "claude", "gemini-cli", "antigravity", "kimi-coding", "qwen"].includes(spec.id),
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });

      if (req.body.providerConfig) {
        const cfg = req.body.providerConfig;
        if (cfg.baseUrl) assertSafeExternalUrl(cfg.baseUrl);
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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

  app.post<{ Params: { projectId: string }; Body: { provider: string; modelId: string; name?: string; free?: boolean } }>(
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const created = registerCustomModel(req.body.provider, {
        id: req.body.modelId.trim(),
        name: req.body.name?.trim() || undefined,
        free: req.body.free
      });
      return { model: created };
    }
  );

  app.delete<{ Params: { projectId: string }; Body: { provider: string; modelId: string } }>(
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const removed = removeCustomModel(req.body.provider, req.body.modelId);
      return { removed };
    }
  );

  app.patch<{ Params: { projectId: string }; Body: { provider: string; modelId: string; disabled: boolean } }>(
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const model = setModelDisabled(req.body.provider, req.body.modelId, req.body.disabled);
      return { model };
    }
  );

  app.post<{ Params: { projectId: string }; Body: { providerId?: string } }>(
    "/v1/projects/:projectId/runner/connections/import-local",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      return startProviderOAuth(req.params.providerId, req.body?.redirectUri);
    }
  );

  app.get<{ Params: { projectId: string; providerId: string }; Querystring: { state?: string } }>(
    "/v1/projects/:projectId/runner/connections/:providerId/oauth/status",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const status = req.query.state ? getOAuthStateStatus(req.query.state) : { completed: false };
      if (status.completed && status.ok) {
        liveModelsCache.delete(req.params.providerId);
      }
      return {
        completed: status.completed,
        ok: status.ok,
        error: status.error,
        connection: status.connection
          ? {
              provider: status.connection.provider,
              authType: status.connection.authType,
              email: status.connection.email
            }
          : undefined
      };
    }
  );

  app.post<{
    Params: { projectId: string; providerId: string };
    Body: { codeOrUrl?: string; state?: string; deviceCode?: string };
  }>(
    "/v1/projects/:projectId/runner/connections/:providerId/oauth/complete",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });

      const routing = getProjectRouting(ctx.tenantId, req.params.projectId);
      const finopsDowngrade = await resolveActiveFinopsDowngrade({
        ctx,
        projectId: req.params.projectId,
        opRepo,
        projectModelUsage
      });
      const role = req.body.role || "primary";
      const historyText = req.body.messages
        .slice(-16)
        .map((m) => `${m.role === "user" ? "Usuário" : m.role === "assistant" ? "Assistente" : "Sistema"}: ${m.content}`)
        .join("\n\n");

      const started = Date.now();
      if (role === "collaborate") {
        const primaryProvider = finopsDowngrade.downgraded && finopsDowngrade.provider ? finopsDowngrade.provider : routing.primary.provider;
        const primaryModel = finopsDowngrade.downgraded && finopsDowngrade.model ? finopsDowngrade.model : routing.primary.model;
        const secondaryProvider = finopsDowngrade.downgraded && finopsDowngrade.provider ? finopsDowngrade.provider : routing.secondary.provider;
        const secondaryModel = finopsDowngrade.downgraded && finopsDowngrade.model ? finopsDowngrade.model : routing.secondary.model;
        const primaryDraft = await generateWithVercelAiSdk({
          provider: primaryProvider,
          model: primaryModel,
          apiKey: runtimeApiKeys.get(primaryProvider) || getStoredToken(primaryProvider),
          system: `Você é o Agente Principal (projeto '${req.params.projectId}'). Elabore uma análise inicial clara e objetiva para ser revisada pelo Submodelo.`,
          prompt: historyText,
          fallbacks: finopsDowngrade.downgraded ? undefined : routing.fallbacks,
          timeoutMs: 90_000
        });
        const secondaryReview = await generateWithVercelAiSdk({
          provider: secondaryProvider,
          model: secondaryModel,
          apiKey: runtimeApiKeys.get(secondaryProvider) || getStoredToken(secondaryProvider),
          system: `Você é o Submodelo / Agente Secundário (projeto '${req.params.projectId}'). Revise a análise do Agente Principal, aponte riscos, lacunas ou melhorias rápidas.`,
          prompt: `Pergunta do usuário:\n${historyText}\n\nAnálise do Principal:\n${primaryDraft.text}`,
          timeoutMs: 60_000
        });
        const consolidated = await generateWithVercelAiSdk({
          provider: primaryProvider,
          model: primaryModel,
          apiKey: runtimeApiKeys.get(primaryProvider) || getStoredToken(primaryProvider),
          system: `Você é o Agente Principal (projeto '${req.params.projectId}'). Consolide a resposta final incorporando os pontos válidos do Submodelo.`,
          prompt: `Pergunta:\n${historyText}\n\nSua análise inicial:\n${primaryDraft.text}\n\nRevisão do Submodelo (${secondaryReview.provider}/${secondaryReview.model}):\n${secondaryReview.text}`,
          fallbacks: finopsDowngrade.downgraded ? undefined : routing.fallbacks,
          timeoutMs: 90_000
        });
        return {
          reply: consolidated.text,
          secondaryReply: secondaryReview.text,
          secondaryProvider: secondaryReview.provider || secondaryProvider,
          secondaryModel: secondaryReview.model || secondaryModel,
          provider: consolidated.provider || primaryProvider,
          model: consolidated.model || primaryModel,
          finopsDowngraded: finopsDowngrade.downgraded,
          ...(finopsDowngrade.reason ? { downgradeReason: finopsDowngrade.reason } : {}),
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
      const targetProvider = finopsDowngrade.downgraded && finopsDowngrade.provider
        ? finopsDowngrade.provider
        : req.body.provider?.trim() || selected.provider;
      const targetModel = finopsDowngrade.downgraded && finopsDowngrade.model
        ? finopsDowngrade.model
        : req.body.model?.trim() || selected.model;

      const res = await generateWithVercelAiSdk({
        provider: targetProvider,
        model: targetModel,
        apiKey: runtimeApiKeys.get(targetProvider) || getStoredToken(targetProvider),
        system:
          req.body.system?.trim() ||
          `Você é o Brain Chat (${role === "secondary" ? "Submodelo" : "Modelo Principal"} · projeto '${req.params.projectId}'). Responda de forma clara, prática e direta em Markdown.`,
        prompt: historyText,
        fallbacks: req.body.provider || finopsDowngrade.downgraded ? undefined : routing.fallbacks,
        timeoutMs: 90_000
      });

      return {
        reply: res.text,
        provider: res.provider || targetProvider,
        model: res.model || targetModel,
        finopsDowngraded: finopsDowngrade.downgraded,
        ...(finopsDowngrade.reason ? { downgradeReason: finopsDowngrade.reason } : {}),
        attempts: res.attempts ?? 1,
        usage: res.usage,
        latencyMs: Date.now() - started
      };
    }
  );
}

