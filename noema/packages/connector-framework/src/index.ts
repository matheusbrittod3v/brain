import type { KnowledgeItem } from "@noema/core";

export interface ConnectorCursor {
  provider: string;
  connectionId: string;
  cursor?: string;
  lastSyncedAt?: string;
}

export interface ConnectorSyncBatch {
  items: KnowledgeItem[];
  nextCursor?: string;
}

export interface ExternalConnector {
  readonly provider: string;
  syncIncremental(cursor: ConnectorCursor): Promise<ConnectorSyncBatch>;
}

export async function runWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

export function deduplicateCanonicalItems(items: readonly KnowledgeItem[]): KnowledgeItem[] {
  const seen = new Map<string, KnowledgeItem>();
  for (const item of items) {
    const extProvider = String(item.metadata?.externalProvider ?? item.sourceKind);
    const extId = String(item.metadata?.externalId ?? item.sourceId);
    const key = `${item.tenantId}:${item.projectId}:${extProvider}:${extId}`;
    const prev = seen.get(key);
    if (!prev || item.version >= prev.version) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

const GIT_AUTHORITATIVE_DOMAINS = new Set<number>([1, 2, 3, 4, 7, 11]);

export type ConnectorRelationType = "RELATED_TO" | "IMPLEMENTS";

export interface ConnectorRelationEdge {
  fromId: string;
  toId: string;
  type: ConnectorRelationType;
  reason: string;
}

export interface ConnectorConflictAlert {
  externalItemId: string;
  existingItemId: string;
  domainId: number;
  reason: string;
  severity: "warning" | "high";
}

export interface ConnectorRelationResult {
  edges: ConnectorRelationEdge[];
  conflicts: ConnectorConflictAlert[];
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Emite arestas RELATED_TO/IMPLEMENTS e alertas de conflito quando um item externo
 * colide com um domínio autoritativo em Git (01–04, 07, 11).
 */
export function buildConnectorRelationsAndConflicts(
  item: KnowledgeItem,
  existingItems: readonly KnowledgeItem[]
): ConnectorRelationResult {
  const edges: ConnectorRelationEdge[] = [];
  const conflicts: ConnectorConflictAlert[] = [];
  const seenEdges = new Set<string>();
  const itemNormTitle = normalizeTitle(item.title);

  const addEdge = (toId: string, type: ConnectorRelationType, reason: string) => {
    const key = `${item.id}:${toId}:${type}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ fromId: item.id, toId, type, reason });
  };

  for (const existing of existingItems) {
    if (
      existing.id === item.id ||
      existing.tenantId !== item.tenantId ||
      existing.projectId !== item.projectId
    ) {
      continue;
    }

    const explicitRef =
      item.relatedIds.includes(existing.id) ||
      item.content.includes(existing.id) ||
      item.title.includes(existing.id);
    const sameTitle = itemNormTitle.length > 0 && itemNormTitle === normalizeTitle(existing.title);

    if (!explicitRef && !sameTitle) continue;

    const relationType: ConnectorRelationType =
      item.type === "task" || existing.type === "requirement" || existing.type === "business_rule"
        ? "IMPLEMENTS"
        : "RELATED_TO";

    addEdge(
      existing.id,
      relationType,
      explicitRef ? `Referência explícita a ${existing.id}` : `Título equivalente: "${existing.title}"`
    );

    const isGitAuthoritative =
      existing.sourceKind === "git" && GIT_AUTHORITATIVE_DOMAINS.has(existing.domainId);
    if (item.sourceKind === "connector" && isGitAuthoritative && (sameTitle || explicitRef)) {
      conflicts.push({
        externalItemId: item.id,
        existingItemId: existing.id,
        domainId: existing.domainId,
        reason: sameTitle
          ? `Colisão de título com item Git autoritativo (${existing.id}) no domínio ${existing.domainId}`
          : `Item externo referencia item Git autoritativo (${existing.id}) no domínio ${existing.domainId}`,
        severity: existing.status === "approved" ? "high" : "warning"
      });
    }
  }

  return { edges, conflicts };
}

