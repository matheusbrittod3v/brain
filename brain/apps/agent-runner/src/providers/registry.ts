import type { ModelCatalogItem, ProviderSpec } from "./types.js";

const LOCAL_PROVIDERS: Record<string, ProviderSpec> = {
  ollama: {
    id: "ollama",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    envKey: "OLLAMA_BASE_URL",
    defaultApiKey: "ollama",
    hasFree: true
  },
  lmstudio: {
    id: "lmstudio",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    defaultApiKey: "lm-studio",
    hasFree: true
  },
  llamacpp: {
    id: "llamacpp",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    defaultApiKey: "llamacpp",
    hasFree: true
  },
  vllm: {
    id: "vllm",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    defaultApiKey: "vllm",
    hasFree: true
  },
  localai: {
    id: "localai",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    defaultApiKey: "localai",
    hasFree: true
  }
};

const CLOUD_PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    id: "openai",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY"
  },
  anthropic: {
    id: "anthropic",
    mode: "http",
    format: "anthropic",
    envKey: "ANTHROPIC_API_KEY"
  },
  gemini: {
    id: "gemini",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    hasFree: true
  },
  openrouter: {
    id: "openrouter",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    hasFree: true,
    publicModelsList: true,
    headers: {
      "HTTP-Referer": "https://brain.local",
      "X-Title": "Brain Agent Runner"
    }
  },
  groq: {
    id: "groq",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    hasFree: true
  },
  deepseek: {
    id: "deepseek",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY"
  },
  mistral: {
    id: "mistral",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.mistral.com/v1",
    envKey: "MISTRAL_API_KEY"
  },
  xai: {
    id: "xai",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY"
  },
  together: {
    id: "together",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY"
  },
  fireworks: {
    id: "fireworks",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY"
  },
  cerebras: {
    id: "cerebras",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    hasFree: true
  },
  nvidia: {
    id: "nvidia",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    hasFree: true
  },
  huggingface: {
    id: "huggingface",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    envKey: "HUGGINGFACE_API_KEY",
    hasFree: true
  }
};

const OAUTH_GATEWAY_PROVIDERS: Record<string, ProviderSpec> = {
  codex: {
    id: "codex",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    envKey: "CODEX_ACCESS_TOKEN"
  },
  claude: {
    id: "claude",
    mode: "http",
    format: "anthropic",
    envKey: "CLAUDE_OAUTH_TOKEN"
  },
  github: {
    id: "github",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "https://api.githubcopilot.com",
    envKey: "GITHUB_COPILOT_TOKEN"
  },
  "9router": {
    id: "9router",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:20128/v1",
    envKey: "NINEROUTER_API_KEY",
    defaultApiKey: "9router"
  },
  cliproxy: {
    id: "cliproxy",
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:8317/v1",
    envKey: "CLIPROXY_API_KEY",
    defaultApiKey: "cliproxy"
  },
  "openai-compatible": {
    id: "openai-compatible",
    mode: "http",
    format: "openai-compatible"
  }
};

const CLI_PROVIDERS: Record<string, ProviderSpec> = {
  "claude-cli": {
    id: "claude-cli",
    mode: "cli",
    cliCommand: ["claude", "-p"],
    models: [
      { id: "sonnet", name: "Claude Sonnet (CLI)" },
      { id: "opus", name: "Claude Opus (CLI)" },
      { id: "haiku", name: "Claude Haiku (CLI)" }
    ]
  },
  "codex-cli": {
    id: "codex-cli",
    mode: "cli",
    cliCommand: ["codex", "exec", "--skip-git-repo-check"],
    models: [
      { id: "default", name: "Codex Default" },
      { id: "gpt-5.4", name: "GPT-5.4 (Codex)" },
      { id: "o3", name: "o3 (Codex)" }
    ]
  },
  "gemini-cli": {
    id: "gemini-cli",
    mode: "cli",
    cliCommand: ["gemini", "-p"],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (CLI)" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (CLI)" }
    ]
  }
};

/**
 * Provider registry adapted from decolua/9router (`open-sse/providers/registry/*.js`).
 */
export const PROVIDER_REGISTRY: Record<string, ProviderSpec> = {
  ...LOCAL_PROVIDERS,
  ...CLOUD_PROVIDERS,
  ...OAUTH_GATEWAY_PROVIDERS,
  ...CLI_PROVIDERS
};

export function registerLlmProvider(id: string, spec: Omit<ProviderSpec, "id">): void {
  const existing = PROVIDER_REGISTRY[id];
  PROVIDER_REGISTRY[id] = { id, ...spec, models: spec.models ?? existing?.models };
}

export function listProviderModels(providerId: string): ModelCatalogItem[] {
  return [...(PROVIDER_REGISTRY[providerId]?.models ?? [])];
}

export function registerCustomModel(providerId: string, model: Omit<ModelCatalogItem, "custom">): ModelCatalogItem {
  const spec = PROVIDER_REGISTRY[providerId];
  if (!spec) {
    throw new Error(`Provider '${providerId}' not found in PROVIDER_REGISTRY`);
  }
  const list = spec.models ?? (spec.models = []);
  const cleanId = model.id.startsWith(`${providerId}/`) ? model.id.slice(providerId.length + 1) : model.id;
  const existing = list.find((m) => m.id === cleanId);
  if (existing) {
    existing.name = model.name ?? existing.name;
    existing.free = model.free ?? existing.free;
    existing.disabled = false;
    return existing;
  }
  const entry: ModelCatalogItem = { id: cleanId, name: model.name || cleanId, free: model.free, custom: true, disabled: false };
  list.push(entry);
  return entry;
}

export function removeCustomModel(providerId: string, modelId: string): boolean {
  const spec = PROVIDER_REGISTRY[providerId];
  if (!spec?.models) return false;
  const idx = spec.models.findIndex((m) => m.id === modelId && m.custom);
  if (idx === -1) return false;
  spec.models.splice(idx, 1);
  return true;
}

export function setModelDisabled(providerId: string, modelId: string, disabled: boolean): ModelCatalogItem | null {
  const spec = PROVIDER_REGISTRY[providerId];
  if (!spec) return null;
  const list = spec.models ?? (spec.models = []);
  const existing = list.find((m) => m.id === modelId);
  if (existing) {
    existing.disabled = disabled;
    return existing;
  }
  const entry: ModelCatalogItem = { id: modelId, name: modelId, disabled };
  list.push(entry);
  return entry;
}

