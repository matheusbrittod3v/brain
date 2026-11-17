export type WorkspaceId =
  | "inbox"
  | "projects"
  | "agents"
  | "knowledge"
  | "search"
  | "impact"
  | "operations"
  | "access"
  | "templates"
  | "enterprise";

export type KnowledgeStatus = "draft" | "approved" | "deprecated" | "superseded";

export interface ProposalItem {
  proposalId: string;
  itemId: string;
  title?: string;
  status: string;
  requestedBy: string;
  actorType?: string;
  createdAt: string;
  dueAt?: string;
  itemJson?: { title?: string; content?: string; type?: string; domainId?: number };
}

export interface KnowledgeHitItem {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  domainId: number;
  sourceUri: string;
  accessPolicyId: string;
  updatedAt: string;
}

export interface SearchHit {
  item: KnowledgeHitItem;
  score: number;
}

export interface InspectedItemState {
  title: string;
  subtitle?: string;
  body: string;
  itemId?: string;
  status?: KnowledgeStatus;
  meta?: Record<string, unknown>;
}

export type ApiFetchFn = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
export type NotifyFn = (text: string, tone?: "info" | "error") => void;

export function normalizeSearchHits(
  data: { items?: KnowledgeHitItem[]; hits?: SearchHit[] } | undefined
): SearchHit[] {
  if (!data) return [];
  if (Array.isArray(data.hits)) return data.hits;
  if (Array.isArray(data.items)) {
    return data.items.map((item) => ({ item, score: 1 }));
  }
  return [];
}

export interface FinOpsModelUsage {
  model: string;
  calls?: number;
  provider?: string;
  costBasis?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens: number | null;
  providerCostUsd: number | null;
}

export interface FinOpsDepartmentQuota {
  department: string;
  monthlyTokenLimit: number;
  monthlyUsdLimit: number;
  usedTokens?: number;
  usedUsd?: number;
  withinQuota?: boolean;
  downgradeModel?: string;
  recommendedDowngradeModel?: string;
  updatedAt?: string;
}

export interface FinOpsData {
  projectId: string;
  indexedItems: number;
  estimatedLocalTokens: number;
  estimatedMonthlySaasSavingsUsd: number | null;
  costTrackingAvailable: boolean;
  actualProviderUsageAvailable: boolean;
  actualProviderCostUsd: number | null;
  modelUsage: {
    windowDays?: number;
    calls: number;
    modelUsageAvailable?: boolean;
    providerCostUsd: number | null;
    byModel: FinOpsModelUsage[];
  };
  infrastructureEstimate: {
    basis?: string;
    computeCostUsd?: number;
    energyKwh?: number;
    energyCostUsd?: number;
    totalInfraAndEnergyUsd: number;
  };
  departmentQuotas?: FinOpsDepartmentQuota[];
  costTrackingNote?: string;
  pgOperationalActive?: boolean;
  pgTemporalActive?: boolean;
}

export interface AuditLogEntry {
  id?: string;
  timestamp?: string;
  createdAt?: string;
  actorId: string;
  actorType?: "human" | "agent" | "service" | string;
  action: string;
  targetType: string;
  targetId: string;
  accessPolicyId?: string;
  tenantId?: string;
  projectId?: string;
  metadata?: Record<string, unknown> | null;
}


