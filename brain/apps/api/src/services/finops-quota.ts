import type { AuthContext } from "@brain/auth";
import type { PgOperationalRepository } from "@brain/database";

export interface ModelUsageSnapshot {
  calls: number;
  providerCostUsd: number | null;
  byModel: Array<{ totalTokens?: number | null }>;
}

export interface EvaluatedFinopsQuota {
  department: string;
  monthlyTokenLimit: number;
  monthlyUsdLimit: number;
  downgradeModel?: string;
  updatedAt: string;
  usedTokens: number;
  usedUsd: number;
  withinQuota: boolean;
  recommendedDowngradeModel?: string;
}

export function estimateInfraAndEnergyUsd(totalTokens: number, calls: number) {
  const durationHours = (calls * 2) / 3600;
  const infraHourlyUsd = Number(process.env.BRAIN_INFRA_HOURLY_USD ?? "0.12");
  const kwhPerMillionTokens = Number(process.env.BRAIN_ENERGY_KWH_PER_MILLION_TOKENS ?? "0.45");
  const energyUsdPerKwh = Number(process.env.BRAIN_ENERGY_USD_PER_KWH ?? "0.15");
  const estimatedInfraUsd = Number((durationHours * infraHourlyUsd).toFixed(6));
  const estimatedEnergyKwh = Number(((totalTokens / 1_000_000) * kwhPerMillionTokens).toFixed(6));
  const estimatedEnergyUsd = Number((estimatedEnergyKwh * energyUsdPerKwh).toFixed(6));
  return { estimatedInfraUsd, estimatedEnergyKwh, estimatedEnergyUsd };
}

export function evaluateFinopsQuotas(
  rawQuotas: Array<{
    department: string;
    monthlyTokenLimit: number;
    monthlyUsdLimit: number;
    downgradeModel?: string;
    updatedAt: string;
  }>,
  modelUsage: ModelUsageSnapshot,
  estimatedLocalTokens = 0
): EvaluatedFinopsQuota[] {
  const measuredTokens = modelUsage.byModel.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0);
  const totalTokens = measuredTokens > 0 ? measuredTokens : estimatedLocalTokens;
  const { estimatedInfraUsd, estimatedEnergyUsd } = estimateInfraAndEnergyUsd(totalTokens, modelUsage.calls);
  const usedUsd = Number(((modelUsage.providerCostUsd ?? 0) + estimatedInfraUsd + estimatedEnergyUsd).toFixed(6));

  return rawQuotas.map((q) => {
    const withinQuota = measuredTokens <= q.monthlyTokenLimit && usedUsd <= q.monthlyUsdLimit;
    const downgradeModel = !withinQuota
      ? (q.downgradeModel ?? process.env.BRAIN_FINOPS_DOWNGRADE_MODEL ?? "ollama:qwen2.5-coder:7b")
      : undefined;
    return {
      ...q,
      usedTokens: measuredTokens,
      usedUsd,
      withinQuota,
      ...(downgradeModel ? { recommendedDowngradeModel: downgradeModel } : {})
    };
  });
}

export function parseProviderModelSpec(spec: string): { provider: string; model: string } {
  const trimmed = spec.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    if (["ollama", "openai", "anthropic", "google", "groq", "openrouter"].includes(prefix)) {
      return { provider: prefix, model: trimmed.slice(colonIdx + 1) };
    }
  }
  return { provider: "ollama", model: trimmed };
}

export async function resolveActiveFinopsDowngrade(deps: {
  ctx: AuthContext;
  projectId: string;
  department?: string;
  opRepo?: PgOperationalRepository;
  projectModelUsage?: (ctx: AuthContext, projectId: string) => Promise<ModelUsageSnapshot>;
}): Promise<{ downgraded: boolean; provider?: string; model?: string; department?: string; reason?: string }> {
  const { ctx, projectId, department, opRepo, projectModelUsage } = deps;
  if (!opRepo || !projectModelUsage) return { downgraded: false };

  const [rawQuotas, usage] = await Promise.all([
    opRepo.listDepartmentFinopsQuotas(ctx, projectId).catch(() => []),
    projectModelUsage(ctx, projectId).catch(() => ({ calls: 0, providerCostUsd: null, byModel: [] }))
  ]);
  if (rawQuotas.length === 0) return { downgraded: false };

  const evaluated = evaluateFinopsQuotas(rawQuotas, usage);
  const target = department
    ? evaluated.find((q) => q.department.toLowerCase() === department.toLowerCase() && !q.withinQuota)
    : evaluated.find((q) => !q.withinQuota);

  if (!target || !target.recommendedDowngradeModel) return { downgraded: false };

  const parsed = parseProviderModelSpec(target.recommendedDowngradeModel);
  return {
    downgraded: true,
    provider: parsed.provider,
    model: parsed.model,
    department: target.department,
    reason: `Cota FinOps do departamento '${target.department}' excedida (tokens=${target.usedTokens}/${target.monthlyTokenLimit}, usd=${target.usedUsd}/${target.monthlyUsdLimit}). Downgrade automático para '${parsed.provider}:${parsed.model}'.`
  };
}
