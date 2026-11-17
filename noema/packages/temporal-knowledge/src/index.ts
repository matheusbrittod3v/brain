import { assertProjectAccess, type AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";

export interface TemporalSnapshotQuery {
  projectId: string;
  atTimestamp?: string;
  commitSha?: string;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * Temporal Knowledge Engine (Project Time Machine):
 * consulta o estado histórico de regras e arquitetura em timestamps ISO-8601 UTC ou commits.
 */
export class TemporalKnowledgeEngine {
  private readonly history: KnowledgeItem[] = [];

  recordVersion(item: KnowledgeItem): void {
    this.history.push(item);
  }

  queryAt(ctx: AuthContext, query: TemporalSnapshotQuery): KnowledgeItem[] {
    assertProjectAccess(ctx, query.projectId);
    const targetMs = query.atTimestamp ? new Date(query.atTimestamp).getTime() : undefined;

    const matching = this.history.filter((item) => {
      if (item.tenantId !== ctx.tenantId) return false;
      if (item.projectId !== query.projectId) return false;
      if (!ctx.allowedPolicies.includes(item.accessPolicyId)) return false;
      if (query.commitSha && item.sourceVersion !== query.commitSha) return false;
      if (targetMs !== undefined) {
        const fromMs = new Date(item.validFrom ?? item.createdAt).getTime();
        const untilMs = item.validUntil ? new Date(item.validUntil).getTime() : Number.POSITIVE_INFINITY;
        if (targetMs < fromMs || targetMs > untilMs) return false;
      }
      return true;
    });

    const latestById = new Map<string, KnowledgeItem>();
    for (const item of matching) {
      const prev = latestById.get(item.id);
      if (!prev || item.version >= prev.version) {
        latestById.set(item.id, item);
      }
    }
    return [...latestById.values()];
  }

  diffSnapshots(before: readonly KnowledgeItem[], after: readonly KnowledgeItem[]): SnapshotDiff {
    const beforeMap = new Map(before.map((i) => [i.id, i]));
    const afterMap = new Map(after.map((i) => [i.id, i]));

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];

    for (const [id, item] of afterMap) {
      const prev = beforeMap.get(id);
      if (!prev) added.push(id);
      else if (prev.contentHash !== item.contentHash) modified.push(id);
    }
    for (const id of beforeMap.keys()) {
      if (!afterMap.has(id)) removed.push(id);
    }
    return { added, removed, modified };
  }
}

export interface TemporalSqlClient {
  withRlsTransaction<T>(
    ctx: { tenantId: string; allowedProjects: readonly string[]; allowedPolicies: readonly string[] },
    fn: (tx: (strings: TemplateStringsArray, ...values: readonly unknown[]) => PromiseLike<unknown>) => Promise<T>
  ): Promise<T>;
}

export class PgTemporalKnowledgeRepository {
  constructor(private readonly client: TemporalSqlClient) {}

  async queryVersionsAt(
    ctx: AuthContext,
    query: TemporalSnapshotQuery
  ): Promise<Array<{ itemId: string; version: number; title: string; status: string; sourceVersion: string; content: string }>> {
    assertProjectAccess(ctx, query.projectId);
    return this.client.withRlsTransaction(
      { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
      async (tx) => {
        const rows = (await tx`
          SELECT DISTINCT ON (item_id) item_id, version, title, status, source_version, content
          FROM knowledge_item_versions
          WHERE tenant_id = ${ctx.tenantId}
            AND project_id = ${query.projectId}
            AND (${query.commitSha ?? null}::text IS NULL OR source_version = ${query.commitSha ?? null})
            AND (${query.atTimestamp ?? null}::timestamptz IS NULL OR created_at <= ${query.atTimestamp ?? null}::timestamptz)
          ORDER BY item_id, version DESC
        `) as Array<{ item_id: string; version: number; title: string; status: string; source_version: string; content: string }>;
        return rows.map((r) => ({
          itemId: r.item_id,
          version: r.version,
          title: r.title,
          status: r.status,
          sourceVersion: r.source_version,
          content: r.content
        }));
      }
    );
  }
}
