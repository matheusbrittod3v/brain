import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStoredConnection, getStoredToken } from "../oauth-connections.js";
import { PROVIDER_REGISTRY } from "./registry.js";
import type { LiveModelsResult, ModelCatalogItem } from "./types.js";

const execFileAsync = promisify(execFile);

export function normalizeOpenAiBaseUrl(rawUrl: string, providerId?: string): string {
  const trimmed = rawUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1") || trimmed.endsWith("/openai")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (providerId === "ollama" || parsed.pathname === "" || parsed.pathname === "/") {
      return `${trimmed}/v1`;
    }
  } catch {
    // Keep raw URL if not parseable as absolute URL
  }
  return trimmed;
}

/**
 * Queries a provider's real connection for actually available models (adapted from 9Router).
 */
export async function fetchProviderLiveModels(
  providerId: string,
  opts?: { apiKey?: string; baseUrl?: string; timeoutMs?: number }
): Promise<LiveModelsResult> {
  const spec = PROVIDER_REGISTRY[providerId];
  if (!spec) {
    return { provider: providerId, online: false, models: [], error: "Provedor desconhecido" };
  }

  const extraPath = process.env.HOME ? `${process.env.HOME}/.local/bin:/opt/homebrew/bin` : "/opt/homebrew/bin";
  if (spec.mode === "cli") {
    const bin = spec.cliCommand?.[0] || providerId;
    try {
      await execFileAsync("which", [bin], {
        env: { ...process.env, PATH: `${extraPath}:${process.env.PATH || ""}` },
        timeout: 1500
      });
      if (providerId === "antigravity-cli") {
        try {
          const { stdout } = await execFileAsync(bin, ["models"], {
            env: { ...process.env, PATH: `${extraPath}:${process.env.PATH || ""}` },
            timeout: 4000
          });
          const parsed: ModelCatalogItem[] = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("Fetching "))
            .map((line) => {
              const [id, ...nameParts] = line.split("\t");
              const modelId = (id || "").trim();
              const name = nameParts.join(" ").trim() || modelId;
              return { id: modelId, name, free: true };
            })
            .filter((m) => Boolean(m.id));
          if (parsed.length > 0) {
            return { provider: providerId, online: true, models: parsed };
          }
        } catch {
          // Fall back to static spec.models when `agy models` is slow/unavailable
        }
      }
      return {
        provider: providerId,
        online: true,
        models: spec.models ? [...spec.models] : [{ id: "default", name: `${providerId} default`, free: true }]
      };
    } catch {
      return { provider: providerId, online: false, models: [], error: `Binário '${bin}' não instalado` };
    }
  }

  const storedConn = getStoredConnection(providerId);
  const rawBase =
    opts?.baseUrl ||
    storedConn?.baseUrl ||
    (providerId === "ollama" ? process.env.OLLAMA_BASE_URL : undefined) ||
    (providerId === "9router" ? process.env.NINEROUTER_BASE_URL : undefined) ||
    spec.baseUrl;

  if (!rawBase && spec.format !== "anthropic") {
    return { provider: providerId, online: false, models: [], error: "Base URL não configurada" };
  }

  const apiKey =
    opts?.apiKey ||
    getStoredToken(providerId) ||
    (spec.envKey ? process.env[spec.envKey] : undefined) ||
    spec.defaultApiKey;

  const isLocal = ["ollama", "lmstudio", "llamacpp", "vllm", "localai", "9router", "cliproxy"].includes(providerId);
  if (!apiKey && !isLocal && !spec.publicModelsList) {
    return { provider: providerId, online: false, models: [], error: `Sem ${spec.envKey || "API key / OAuth"}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 2500);
  try {
    if (providerId === "codex") {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.169.0",
        version: "0.169.0"
      };
      if (storedConn?.accountId) headers["chatgpt-account-id"] = storedConn.accountId;
      const res = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=0.169.0", {
        headers,
        signal: controller.signal
      });
      if (!res.ok) return { provider: providerId, online: false, models: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as { models?: Array<{ slug?: string; id?: string; display_name?: string; name?: string }> };
      const rawList = Array.isArray(json) ? json : json.models || [];
      const models: ModelCatalogItem[] = rawList
        .filter((m: any) => Boolean(m?.slug || m?.id || m?.model || m?.name))
        .map((m: any) => {
          const id = String(m.slug || m.id || m.model || m.name);
          return { id, name: String(m.display_name || m.name || id) };
        });
      return { provider: providerId, online: true, models };
    }

    if (providerId === "ollama") {
      const root = (rawBase || "http://localhost:11434").replace(/\/v1\/?$/, "").replace(/\/$/, "");
      const res = await fetch(`${root}/api/tags`, { signal: controller.signal });
      if (!res.ok) return { provider: providerId, online: false, models: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const models: ModelCatalogItem[] = (json.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => Boolean(n))
        .map((id) => ({ id, name: id, free: true }));
      return { provider: providerId, online: true, models };
    }

    if (providerId === "gemini" || providerId === "antigravity") {
      const headers: Record<string, string> = {};
      if (apiKey) {
        if (storedConn?.authType === "oauth" || storedConn?.authType === "local-import") {
          headers.Authorization = `Bearer ${apiKey}`;
        } else {
          headers["x-goog-api-key"] = apiKey;
        }
      }
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal: controller.signal
      });
      if (!res.ok) {
        if (providerId === "antigravity" && storedConn?.accessToken) {
          return {
            provider: providerId,
            online: true,
            models: spec.models ? [...spec.models] : [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", free: true }]
          };
        }
        return { provider: providerId, online: false, models: [], error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as { models?: Array<{ name?: string; displayName?: string }> };
      const models: ModelCatalogItem[] = (json.models ?? [])
        .filter((m): m is { name: string; displayName?: string } => Boolean(m.name))
        .map((m) => {
          const id = m.name.replace(/^models\//, "");
          return { id, name: m.displayName || id, free: true };
        });
      return { provider: providerId, online: true, models };
    }

    if (spec.format === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey || "",
          "anthropic-version": "2023-06-01"
        },
        signal: controller.signal
      });
      if (!res.ok) return { provider: providerId, online: false, models: [], error: `HTTP ${res.status}` };
      const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
      const models: ModelCatalogItem[] = (json.data ?? [])
        .filter((m): m is { id: string; display_name?: string } => Boolean(m.id))
        .map((m) => ({ id: m.id, name: m.display_name || m.id }));
      return { provider: providerId, online: true, models };
    }

    const base = normalizeOpenAiBaseUrl(rawBase!, providerId);
    const headers: Record<string, string> = { ...spec.headers };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: controller.signal });
    if (!res.ok) return { provider: providerId, online: false, models: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const rawList = Array.isArray(json) ? json : json.data || json.models || [];
    const models: ModelCatalogItem[] = rawList
      .filter((m: any) => Boolean(m?.id))
      .map((m: any) => {
        const isFree =
          Boolean(spec.hasFree && isLocal) ||
          String(m.id).endsWith(":free") ||
          (m.pricing?.prompt === "0" && m.pricing?.completion === "0");
        return {
          id: String(m.id),
          name: String(m.name || m.id),
          free: isFree
        };
      });
    return { provider: providerId, online: true, models };
  } catch (err) {
    return {
      provider: providerId,
      online: false,
      models: [],
      error: err instanceof Error ? err.message : "Offline"
    };
  } finally {
    clearTimeout(timer);
  }
}

