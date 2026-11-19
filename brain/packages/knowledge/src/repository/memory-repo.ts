import type { KnowledgeItem } from "@brain/core";
import type { RlsSessionContext } from "@brain/database";
import {
  validateScopeAndProject,
  validateToken,
  type KnowledgeItemVersion,
  type KnowledgeRepository,
  type ReplaceItemEmbeddingsInput,
  type UpsertKnowledgeResult
} from "./types.js";
import {
  resolveIsoTimestamp,
  toVersionSnapshot,
  validateKnowledgeItemForRlsContext
} from "./validators.js";

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly versions = new Map<string, KnowledgeItemVersion[]>();
  private readonly embeddingsCountByItem = new Map<string, number>();
  private readonly now: () => Date;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  seedEmbeddingCountForItem(tenantId: string, projectId: string, itemId: string, count: number): void {
    this.embeddingsCountByItem.set(`${tenantId}:${projectId}:${itemId}`, count);
  }

  getEmbeddingCountForItem(tenantId: string, projectId: string, itemId: string): number {
    return this.embeddingsCountByItem.get(`${tenantId}:${projectId}:${itemId}`) ?? 0;
  }

  async upsertItem(
    context: RlsSessionContext,
    input: KnowledgeItem
  ): Promise<UpsertKnowledgeResult> {
    const { item, resolvedContext } = validateKnowledgeItemForRlsContext(input, context);
    const allowedPolicies = new Set(resolvedContext.allowedPoliciesCsv.split(","));
    const key = `${item.tenantId}:${item.projectId}:${item.id}`;
    const existing = this.items.get(key);
    const nowIso = resolveIsoTimestamp(this.now);

    if (existing) {
      if (!allowedPolicies.has(existing.accessPolicyId)) {
        throw new Error(
          `Existing KnowledgeItem '${existing.id}' is governed by policy '${existing.accessPolicyId}' which is not in allowedPolicies.`
        );
      }

      if (existing.contentHash === item.contentHash && existing.deletedAt === undefined) {
        return {
          item: structuredClone(existing),
          versionCreated: false
        };
      }

      const nextVersion = existing.version + 1;
      const updated: KnowledgeItem = {
        ...item,
        version: nextVersion,
        createdAt: existing.createdAt,
        updatedAt: nowIso
      };
      delete updated.deletedAt;

      this.items.set(key, structuredClone(updated));
      const list = this.versions.get(key) ?? [];
      list.push(toVersionSnapshot(updated, nowIso));
      this.versions.set(key, list);

      return {
        item: structuredClone(updated),
        versionCreated: true
      };
    }

    const initialVersion = Number.isInteger(item.version) && item.version >= 1 ? item.version : 1;
    const created: KnowledgeItem = {
      ...item,
      version: initialVersion,
      createdAt: item.createdAt || nowIso,
      updatedAt: nowIso
    };
    delete created.deletedAt;

    this.items.set(key, structuredClone(created));
    const list = this.versions.get(key) ?? [];
    list.push(toVersionSnapshot(created, nowIso));
    this.versions.set(key, list);

    return {
      item: structuredClone(created),
      versionCreated: true
    };
  }

  async getItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItem | undefined> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);
    if (!existing || existing.deletedAt !== undefined) return undefined;
    if (!allowedPolicies.has(existing.accessPolicyId)) return undefined;
    return structuredClone(existing);
  }

  async listVersions(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItemVersion[]> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const list = this.versions.get(key) ?? [];
    return list
      .filter((v) => allowedPolicies.has(v.accessPolicyId))
      .sort((a, b) => a.version - b.version)
      .map((v) => structuredClone(v));
  }

  async softDeleteItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string,
    deletedAt?: string
  ): Promise<boolean> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const deletedIso = resolveIsoTimestamp(this.now, deletedAt);
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);

    if (!existing || existing.deletedAt !== undefined) return false;
    if (!allowedPolicies.has(existing.accessPolicyId)) return false;

    existing.deletedAt = deletedIso;
    existing.updatedAt = deletedIso;
    this.embeddingsCountByItem.delete(key);
    return true;
  }

  async replaceItemEmbeddings(
    context: RlsSessionContext,
    input: ReplaceItemEmbeddingsInput
  ): Promise<number> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(
      context,
      input.projectId
    );
    const normalizedItemId = validateToken(input.knowledgeItemId, "knowledgeItemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);
    if (!existing || existing.deletedAt !== undefined) return 0;
    if (!allowedPolicies.has(existing.accessPolicyId)) return 0;

    this.embeddingsCountByItem.set(key, input.chunks.length);
    return input.chunks.length;
  }
}

