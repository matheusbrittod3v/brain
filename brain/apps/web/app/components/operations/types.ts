export interface FinOpsModelUsageItem {
  model: string
  provider?: string
  calls?: number
  totalTokens: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  providerCostUsd: number | null
}

export interface FinOpsDepartmentQuota {
  department: string
  monthlyTokenLimit: number
  monthlyUsdLimit: number
  usedTokens?: number
  usedUsd?: number
  withinQuota?: boolean
  downgradeModel?: string
  recommendedDowngradeModel?: string
}

export interface FinOpsData {
  estimatedLocalTokens: number
  actualProviderUsageAvailable?: boolean
  modelUsage: {
    calls: number
    providerCostUsd?: number | null
    byModel: FinOpsModelUsageItem[]
  }
  infrastructureEstimate: {
    computeCostUsd?: number
    energyKwh?: number
    energyCostUsd?: number
    totalInfraAndEnergyUsd: number
  }
  departmentQuotas?: FinOpsDepartmentQuota[]
  pgOperationalActive?: boolean
  pgTemporalActive?: boolean
}

export interface AuditLogItem {
  id?: string
  createdAt?: string
  timestamp?: string
  actorId: string
  actorType?: string
  action: string
  targetType: string
  targetId: string
  accessPolicyId?: string
  metadata?: Record<string, unknown> | null
}

export interface LiveUsageData {
  summary: {
    totalRequests: number
    successRequests: number
    failedRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
    totalTokens: number
    totalCostUsd: number
    avgLatencyMs: number
    byProvider: Array<{ provider: string; requests: number; totalTokens: number; costUsd: number }>
    byModel: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }>
  }
  logs: Array<{
    id: string
    timestamp: string
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    latencyMs: number
    status: 'ok' | 'error'
    error?: string
  }>
}

export function formatCompactNumber(n: number) {
  return new Intl.NumberFormat('pt-BR', {
    notation: n >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(n)
}

