export interface ModelPricingEntry {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

export interface UsageLogEntry {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface UsageSummaryStats {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byProvider: Array<{
    provider: string;
    requests: number;
    totalTokens: number;
    costUsd: number;
  }>;
  byModel: Array<{
    provider: string;
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  }>;
}

/**
 * USD per 1M tokens pricing table adapted from decolua/9router (`open-sse/providers/pricing.js`).
 */
export const MODEL_PRICING: Record<string, ModelPricingEntry> = {
  "gpt-4o": { input: 2.5, output: 10.0, cached: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  "o3-mini": { input: 1.1, output: 4.4, cached: 0.55 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cached: 0.3 },
  "claude-opus-4-20250514": { input: 15.0, output: 25.0, cached: 7.5 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0, cached: 1.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0, cached: 0.31 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6, cached: 0.0375 },
  "deepseek-chat": { input: 0.27, output: 1.1, cached: 0.07 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cached: 0.14 },
  "mistral-large-latest": { input: 2.0, output: 6.0 },
  "codestral-latest": { input: 0.3, output: 0.9 },
  "grok-3": { input: 3.0, output: 15.0 },
  "grok-3-mini": { input: 0.3, output: 0.5 }
};

const FREE_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp", "vllm", "localai", "codex-cli", "claude-cli", "gemini-cli"]);

export function resolveModelPricing(provider: string, model: string): ModelPricingEntry {
  if (FREE_PROVIDERS.has(provider) || model.endsWith(":free")) {
    return { input: 0, output: 0, cached: 0 };
  }
  const baseModel = model.includes("/") ? model.split("/").pop() || model : model;
  return MODEL_PRICING[baseModel] || MODEL_PRICING[model] || { input: 0, output: 0, cached: 0 };
}

/**
 * Ported from 9router `calculateCostFromTokens`: avoids double-charging cached input tokens.
 */
export function calculateCostFromTokens(
  tokens: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number },
  pricing: ModelPricingEntry
): number {
  const input = tokens.inputTokens ?? 0;
  const output = tokens.outputTokens ?? 0;
  const cached = tokens.cachedTokens ?? 0;
  const reasoning = tokens.reasoningTokens ?? 0;
  const nonCachedInput = Math.max(0, input - cached);

  let cost = 0;
  cost += nonCachedInput * (pricing.input / 1_000_000);
  if (cached > 0) {
    cost += cached * ((pricing.cached ?? pricing.input) / 1_000_000);
  }
  cost += output * (pricing.output / 1_000_000);
  if (reasoning > 0) {
    cost += reasoning * ((pricing.reasoning ?? pricing.output) / 1_000_000);
  }
  return Number(cost.toFixed(6));
}

const MAX_USAGE_LOGS = 200;
const usageLogs: UsageLogEntry[] = [];

export function recordModelUsage(entry: Omit<UsageLogEntry, "id" | "timestamp" | "costUsd"> & { costUsd?: number }): UsageLogEntry {
  const pricing = resolveModelPricing(entry.provider, entry.model);
  const costUsd =
    entry.costUsd ??
    calculateCostFromTokens(
      {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cachedTokens: entry.cachedTokens
      },
      pricing
    );

  const record: UsageLogEntry = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
    costUsd
  };

  usageLogs.unshift(record);
  if (usageLogs.length > MAX_USAGE_LOGS) {
    usageLogs.length = MAX_USAGE_LOGS;
  }
  return record;
}

export function getRecentUsageLogs(limit = 50): UsageLogEntry[] {
  return usageLogs.slice(0, Math.max(1, limit));
}

export function getUsageSummary(): UsageSummaryStats {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let latencySum = 0;
  let successRequests = 0;
  let failedRequests = 0;

  const byProviderMap = new Map<string, { provider: string; requests: number; totalTokens: number; costUsd: number }>();
  const byModelMap = new Map<
    string,
    { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }
  >();

  for (const log of usageLogs) {
    if (log.status === "ok") successRequests += 1;
    else failedRequests += 1;
    totalInputTokens += log.inputTokens;
    totalOutputTokens += log.outputTokens;
    totalCachedTokens += log.cachedTokens;
    totalTokens += log.totalTokens;
    totalCostUsd += log.costUsd;
    latencySum += log.latencyMs;

    const pEntry = byProviderMap.get(log.provider) ?? { provider: log.provider, requests: 0, totalTokens: 0, costUsd: 0 };
    pEntry.requests += 1;
    pEntry.totalTokens += log.totalTokens;
    pEntry.costUsd = Number((pEntry.costUsd + log.costUsd).toFixed(6));
    byProviderMap.set(log.provider, pEntry);

    const mKey = `${log.provider}/${log.model}`;
    const mEntry = byModelMap.get(mKey) ?? {
      provider: log.provider,
      model: log.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    };
    mEntry.requests += 1;
    mEntry.inputTokens += log.inputTokens;
    mEntry.outputTokens += log.outputTokens;
    mEntry.totalTokens += log.totalTokens;
    mEntry.costUsd = Number((mEntry.costUsd + log.costUsd).toFixed(6));
    byModelMap.set(mKey, mEntry);
  }

  return {
    totalRequests: usageLogs.length,
    successRequests,
    failedRequests,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    avgLatencyMs: usageLogs.length > 0 ? Math.round(latencySum / usageLogs.length) : 0,
    byProvider: Array.from(byProviderMap.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: Array.from(byModelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

