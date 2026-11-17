import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import type { ActorType, AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";
import * as schema from "./schema.js";
import {
  auditLogs,
  knowledgeEmbeddings,
  knowledgeItems,
  knowledgeItemVersions,
  knowledgeRelations,
  syncProjectLocks,
  syncChanges
} from "./schema.js";
import { withTenantRls, type NoemaDb } from "./client.js";
import { resolveRlsSessionContext, withRlsTransaction, type RlsSessionContext } from "./rls-context.js";

export class PgKnowledgeRepository {
  constructor(private readonly db: NoemaDb) {}

  async getEmbeddingSource(
    ctx: AuthContext,
    input: { projectId: string; itemId: string; sourceVersion: string }
  ): Promise<{ content: string; accessPolicyId: string } | undefined> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select({ content: knowledgeItemVersions.content, accessPolicyId: knowledgeItemVersions.accessPolicyId })
        .from(knowledgeItemVersions)
        .innerJoin(knowledgeItems, and(
          eq(knowledgeItems.tenantId, knowledgeItemVersions.tenantId),
          eq(knowledgeItems.projectId, knowledgeItemVersions.projectId),
          eq(knowledgeItems.id, knowledgeItemVersions.itemId)
        ))
        .where(and(
          eq(knowledgeItemVersions.tenantId, ctx.tenantId),
          eq(knowledgeItemVersions.projectId, input.projectId),
          eq(knowledgeItemVersions.itemId, input.itemId),
          eq(knowledgeItemVersions.sourceVersion, input.sourceVersion),
          isNull(knowledgeItems.deletedAt)
        ))
        .limit(1);
      return rows[0];
    });
  }

  async incrementHitCounts(
    ctx: AuthContext,
    projectId: string,
    itemIds: readonly string[]
  ): Promise<Array<{ itemId: string; hitCount: number }>> {
    const uniqueIds = [...new Set(itemIds)];
    if (uniqueIds.length === 0) return [];
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .update(knowledgeItems)
        .set({ hitCount: sql`${knowledgeItems.hitCount} + 1` })
        .where(and(
          eq(knowledgeItems.tenantId, ctx.tenantId),
          eq(knowledgeItems.projectId, projectId),
          inArray(knowledgeItems.id, uniqueIds),
          isNull(knowledgeItems.deletedAt)
        ))
        .returning({ itemId: knowledgeItems.id, hitCount: knowledgeItems.hitCount });
      if (rows.length !== uniqueIds.length) {
        throw new Error("One or more feedback items are missing or outside the authorized scope.");
      }
      return rows;
    });
  }

  async incrementHitCount(ctx: AuthContext, projectId: string, itemId: string): Promise<number | undefined> {
    const rows = await this.incrementHitCounts(ctx, projectId, [itemId]);
    return rows[0]?.hitCount;
  }

  async upsertItem(ctx: AuthContext, item: KnowledgeItem): Promise<{ version: number; changed: boolean; sourceVersion: string }> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const existing = await tx
        .select()
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.tenantId, item.tenantId),
            eq(knowledgeItems.projectId, item.projectId),
            eq(knowledgeItems.id, item.id)
          )
        )
        .limit(1);

      if (existing[0] && existing[0].contentHash === item.contentHash && existing[0].deletedAt === null) {
        return { version: existing[0].version, changed: false, sourceVersion: existing[0].sourceVersion };
      }

      const nextVersion = existing[0] ? existing[0].version + 1 : item.version;

      await tx
        .insert(knowledgeItems)
        .values({
          id: item.id,
          tenantId: item.tenantId,
          projectId: item.projectId,
          domainId: item.domainId,
          type: item.type,
          title: item.title,
          content: item.content,
          summary: item.summary,
          status: item.status,
          sourceId: item.sourceId,
          sourceOrigin: item.sourceOrigin,
          sourceKind: item.sourceKind,
          sourceVersion: item.sourceVersion,
          sourceUri: item.sourceUri,
          version: nextVersion,
          contentHash: item.contentHash,
          ownerId: item.ownerId,
          confidence: item.confidence,
          trustLevel: item.trustLevel,
          isInferred: item.isInferred,
          tags: item.tags,
          accessPolicyId: item.accessPolicyId,
          metadata: item.metadata ?? {}
        })
        .onConflictDoUpdate({
          target: [knowledgeItems.tenantId, knowledgeItems.projectId, knowledgeItems.id],
          set: {
            title: item.title,
            content: item.content,
            summary: item.summary,
            status: item.status,
            sourceVersion: item.sourceVersion,
            version: nextVersion,
            contentHash: item.contentHash,
            tags: item.tags,
            metadata: item.metadata ?? {},
            deletedAt: null,
            updatedAt: new Date()
          }
        });

      await tx.insert(knowledgeItemVersions).values({
        tenantId: item.tenantId,
        projectId: item.projectId,
        itemId: item.id,
        version: nextVersion,
        domainId: item.domainId,
        type: item.type,
        title: item.title,
        summary: item.summary,
        status: item.status,
        sourceOrigin: item.sourceOrigin,
        sourceKind: item.sourceKind,
        sourceVersion: item.sourceVersion,
        contentHash: item.contentHash,
        ownerId: item.ownerId,
        confidence: item.confidence,
        trustLevel: item.trustLevel,
        isInferred: item.isInferred,
        tags: item.tags,
        accessPolicyId: item.accessPolicyId,
        content: item.content,
        metadata: item.metadata ?? {}
      });

      await tx.insert(syncProjectLocks).values({
        tenantId: item.tenantId,
        projectId: item.projectId,
        lockedAt: new Date()
      }).onConflictDoUpdate({
        target: [syncProjectLocks.tenantId, syncProjectLocks.projectId],
        set: { lockedAt: new Date() }
      });
      await tx.insert(syncChanges).values({
        tenantId: item.tenantId,
        projectId: item.projectId,
        itemId: item.id,
        contentHash: item.contentHash,
        accessPolicyId: item.accessPolicyId
      });

      return { version: nextVersion, changed: true, sourceVersion: item.sourceVersion };
    });
  }

  async retireGitSources(ctx: AuthContext, input: { projectId: string; repository: string; sourceUris: readonly string[] }): Promise<number> {
    const uris = [...new Set(input.sourceUris)];
    if (!uris.length) return 0;
    return withTenantRls(this.db, ctx, async (tx) => {
      const found = await tx.select({ id: knowledgeItems.id }).from(knowledgeItems).where(and(
        eq(knowledgeItems.tenantId, ctx.tenantId), eq(knowledgeItems.projectId, input.projectId),
        eq(knowledgeItems.sourceKind, "git"), inArray(knowledgeItems.sourceUri, uris),
        sql`${knowledgeItems.metadata}->>'sourceRepository' = ${input.repository.toLowerCase()}`,
        isNull(knowledgeItems.deletedAt)
      ));
      const ids = found.map((row) => row.id);
      if (!ids.length) return 0;
      await tx.update(knowledgeItems).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(knowledgeItems.tenantId, ctx.tenantId), eq(knowledgeItems.projectId, input.projectId), inArray(knowledgeItems.id, ids)
      ));
      await tx.delete(knowledgeEmbeddings).where(and(eq(knowledgeEmbeddings.tenantId, ctx.tenantId), eq(knowledgeEmbeddings.projectId, input.projectId), inArray(knowledgeEmbeddings.knowledgeItemId, ids)));
      await tx.delete(knowledgeRelations).where(and(eq(knowledgeRelations.tenantId, ctx.tenantId), or(
        and(eq(knowledgeRelations.fromProjectId, input.projectId), inArray(knowledgeRelations.fromItemId, ids)),
        and(eq(knowledgeRelations.toProjectId, input.projectId), inArray(knowledgeRelations.toItemId, ids))
      )));
      return ids.length;
    });
  }

  async retireGitSourcesExcept(ctx: AuthContext, input: { projectId: string; repository: string; retainedSourceUris: readonly string[] }): Promise<number> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const retained = [...new Set(input.retainedSourceUris)];
      const found = await tx.select({ id: knowledgeItems.id }).from(knowledgeItems).where(and(
        eq(knowledgeItems.tenantId, ctx.tenantId), eq(knowledgeItems.projectId, input.projectId),
        eq(knowledgeItems.sourceKind, "git"),
        sql`${knowledgeItems.metadata}->>'sourceRepository' = ${input.repository.toLowerCase()}`,
        isNull(knowledgeItems.deletedAt), ...(retained.length ? [notInArray(knowledgeItems.sourceUri, retained)] : [])
      ));
      const ids = found.map((row) => row.id);
      if (!ids.length) return 0;
      await tx.update(knowledgeItems).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(knowledgeItems.tenantId, ctx.tenantId), eq(knowledgeItems.projectId, input.projectId), inArray(knowledgeItems.id, ids)));
      await tx.delete(knowledgeEmbeddings).where(and(eq(knowledgeEmbeddings.tenantId, ctx.tenantId), eq(knowledgeEmbeddings.projectId, input.projectId), inArray(knowledgeEmbeddings.knowledgeItemId, ids)));
      await tx.delete(knowledgeRelations).where(and(eq(knowledgeRelations.tenantId, ctx.tenantId), or(
        and(eq(knowledgeRelations.fromProjectId, input.projectId), inArray(knowledgeRelations.fromItemId, ids)),
        and(eq(knowledgeRelations.toProjectId, input.projectId), inArray(knowledgeRelations.toItemId, ids))
      )));
      return ids.length;
    });
  }

  async searchLexical(ctx: AuthContext, projectId: string, query: string, limit = 10) {
    return withTenantRls(this.db, ctx, async (tx) => {
      return tx
        .select()
        .from(knowledgeItems)
        .where(
          and(
            eq(knowledgeItems.projectId, projectId),
            isNull(knowledgeItems.deletedAt),
            sql`to_tsvector('simple', coalesce(${knowledgeItems.title}, '') || ' ' || coalesce(${knowledgeItems.content}, '')) @@ plainto_tsquery('simple', ${query})`
          )
        )
        .limit(limit);
    });
  }

  async upsertEmbedding(
    ctx: AuthContext,
    input: {
      projectId: string;
      knowledgeItemId: string;
      sourceVersion: string;
      chunkIndex: number;
      chunkText: string;
      accessPolicyId: string;
      embeddingModel: string;
      embedding: number[];
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(knowledgeEmbeddings).values({
        tenantId: ctx.tenantId,
        ...input
      }).onConflictDoUpdate({
        target: [
          knowledgeEmbeddings.tenantId,
          knowledgeEmbeddings.projectId,
          knowledgeEmbeddings.knowledgeItemId,
          knowledgeEmbeddings.sourceVersion,
          knowledgeEmbeddings.chunkIndex,
          knowledgeEmbeddings.embeddingModel
        ],
        set: {
          chunkText: input.chunkText,
          accessPolicyId: input.accessPolicyId,
          embedding: input.embedding
        }
      });
    });
  }
}

export class PgGraphRepository {
  constructor(private readonly db: NoemaDb) {}

  async addEdge(
    ctx: AuthContext,
    edge: {
      fromProjectId: string;
      toProjectId: string;
      fromItemId: string;
      toItemId: string;
      fromPolicyId: string;
      toPolicyId: string;
      relationType: string;
      isInferred?: boolean;
      confidence?: number;
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(knowledgeRelations).values({
        tenantId: ctx.tenantId,
        ...edge
      });
    });
  }
}

export interface DbAuditEvent {
  tenantId: string;
  projectId: string | null;
  accessPolicyId: string;
  actorId: string;
  actorType: ActorType;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export class PgAuditLogger {
  constructor(private readonly db: NoemaDb) {}

  async record(event: DbAuditEvent, ctx?: AuthContext): Promise<void> {
    const accessPolicyId = event.accessPolicyId?.trim();
    if (!accessPolicyId) {
      throw new Error("DbAuditEvent.accessPolicyId is required.");
    }

    const rlsContext: RlsSessionContext = ctx
      ? {
          tenantId: ctx.tenantId,
          allowedProjects: ctx.allowedProjects,
          allowedPolicies: ctx.allowedPolicies
        }
      : {
          tenantId: event.tenantId,
          allowedProjects: [event.projectId ?? "__org__"],
          allowedPolicies: [accessPolicyId]
        };

    const values = {
      tenantId: event.tenantId,
      projectId: event.projectId,
      accessPolicyId,
      actorId: event.actorId,
      actorType: event.actorType,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata ?? {}
    };

    const rawClient = (this.db as unknown as { $client?: Sql }).$client;
    if (rawClient && typeof rawClient.begin === "function") {
      await withRlsTransaction(rawClient, rlsContext, async (tx) => {
        const txDb = drizzle(tx as unknown as Sql, { schema });
        await txDb.insert(auditLogs).values(values);
      });
      return;
    }

    const resolved = resolveRlsSessionContext(rlsContext);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT
        set_config('app.current_tenant_id', ${resolved.tenantId}, true),
        set_config('app.allowed_projects', ${resolved.allowedProjectsCsv}, true),
        set_config('app.allowed_policies', ${resolved.allowedPoliciesCsv}, true)`);
      await tx.insert(auditLogs).values(values);
    });
  }
}
