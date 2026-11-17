export type WorkspaceId =
  | "inbox"
  | "projects"
  | "agents"
  | "knowledge"
  | "search"
  | "integrations"
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

