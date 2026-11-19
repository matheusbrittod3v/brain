import type { KnowledgeItem } from "@brain/core";
import { withRlsTransaction, type RlsSessionContext } from "@brain/database";
import {
  validateScopeAndProject,
  validateToken,
  type KnowledgeItemVersion,
  type KnowledgePostgresTarget,
  type KnowledgeRepository,
  type KnowledgeSqlClient,
  type KnowledgeSqlTransactionRunner,
  type PostgresKnowledgeRepositoryOptions,
  type ReplaceItemEmbeddingsInput,
  type UpsertKnowledgeResult
} from "./types.js";
import {
  mapRowToKnowledgeItem,
  mapRowToKnowledgeItemVersion,
  parseOptionalIso,
  resolveIsoTimestamp,
  validateKnowledgeItemForRlsContext,
  type KnowledgeItemRow,
  type KnowledgeItemVersionRow
} from "./validators.js";

export class PostgresKnowledgeRepository<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> implements KnowledgeRepository {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly now: () => Date;

  constructor(
    sqlOrOptions: KnowledgePostgresTarget<TTx> | PostgresKnowledgeRepositoryOptions<TTx>,
    maybeOptions?: { now?: () => Date }
  ) {
    let target: KnowledgePostgresTarget<TTx>;
    let now: (() => Date) | undefined;

    if (sqlOrOptions && typeof sqlOrOptions === "object" && "sql" in sqlOrOptions && !("begin" in sqlOrOptions) && !("withRlsTransaction" in sqlOrOptions)) {
      target = sqlOrOptions.sql;
      now = sqlOrOptions.now;
    } else {
      target = sqlOrOptions as KnowledgePostgresTarget<TTx>;
      now = maybeOptions?.now;
    }

    if (!target || typeof target !== "object") {
      throw new Error("PostgresKnowledgeRepository requires an AppPostgresClient or RlsSqlClient.");
    }

    if ("withRlsTransaction" in target && typeof target.withRlsTransaction === "function") {
      if ("role" in target && target.role !== "brain_app") {
        throw new Error(
          `PostgresKnowledgeRepository requires an AppPostgresClient bound to role 'brain_app' (received '${String(target.role)}').`
        );
      }
      const appClient = target;
      this.runInRlsTransaction = (ctx, cb) => appClient.withRlsTransaction(ctx, cb);
    } else if ("begin" in target && typeof target.begin === "function") {
      const sqlClient = target as KnowledgeSqlClient<TTx>;
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(sqlClient, ctx, cb);
    } else {
      throw new Error(
        "PostgresKnowledgeRepository requires an AppPostgresClient (withRlsTransaction) or RlsSqlClient (begin)."
      );
    }

    this.now = now ?? (() => new Date());
  }

  async upsertItem(
    context: RlsSessionContext,
    input: KnowledgeItem
  ): Promise<UpsertKnowledgeResult> {
    const { item } = validateKnowledgeItemForRlsContext(input, context);
    const nowIso = resolveIsoTimestamp(this.now);
    const validUntilParam: string | null = item.validUntil ?? null;
    const summaryParam: string | null = item.summary ?? null;
    const ownerIdParam: string | null = item.ownerId ?? null;
    const metadataJson = JSON.stringify(item.metadata ?? {});

    return this.runInRlsTransaction(context, async (tx) => {
      let existingRows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${item.tenantId}
        AND project_id = ${item.projectId}
        AND id = ${item.id}
      FOR UPDATE`;

      const appendSyncChange = async () => {
        await tx`INSERT INTO sync_project_locks (tenant_id, project_id)
          VALUES (${item.tenantId}, ${item.projectId})
          ON CONFLICT (tenant_id, project_id) DO UPDATE SET locked_at = now()`;
        await tx`INSERT INTO sync_changes (
          tenant_id, project_id, item_id, content_hash, access_policy_id
        ) VALUES (
          ${item.tenantId}, ${item.projectId}, ${item.id}, ${item.contentHash}, ${item.accessPolicyId}
        )`;
      };

      if (!existingRows[0]) {
        const initialVersion = Number.isInteger(item.version) && item.version >= 1 ? item.version : 1;
        const createdAtIso = item.createdAt || nowIso;
        const validFromIso = item.validFrom ?? nowIso;

        const insertedRows = await tx<KnowledgeItemRow>`INSERT INTO knowledge_items (
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      ) VALUES (
        ${item.id},
        ${item.tenantId},
        ${item.projectId},
        ${item.domainId},
        ${item.type},
        ${item.title},
        ${item.content},
        ${summaryParam},
        ${item.status},
        ${item.sourceId},
        ${item.sourceOrigin},
        ${item.sourceKind},
        ${item.sourceVersion},
        ${item.sourceUri},
        ${initialVersion},
        ${item.contentHash},
        ${ownerIdParam},
        ${item.confidence},
        ${item.trustLevel},
        ${item.isInferred},
        ${validFromIso}::timestamptz,
        ${validUntilParam}::timestamptz,
        ${item.tags},
        ${item.accessPolicyId},
        ${metadataJson}::jsonb,
        NULL,
        ${createdAtIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      ON CONFLICT (tenant_id, project_id, id) DO NOTHING
      RETURNING
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at`;

        const insertedRow = insertedRows[0];
        if (insertedRow) {
          await tx`INSERT INTO knowledge_item_versions (
          tenant_id, project_id, item_id, version, domain_id, type, title, summary,
          status, source_origin, source_kind, source_version, content_hash, owner_id,
          confidence, trust_level, is_inferred, tags, access_policy_id, content,
          metadata, created_at
        ) VALUES (
          ${item.tenantId},
          ${item.projectId},
          ${item.id},
          ${initialVersion},
          ${item.domainId},
          ${item.type},
          ${item.title},
          ${summaryParam},
          ${item.status},
          ${item.sourceOrigin},
          ${item.sourceKind},
          ${item.sourceVersion},
          ${item.contentHash},
          ${ownerIdParam},
          ${item.confidence},
          ${item.trustLevel},
          ${item.isInferred},
          ${item.tags},
          ${item.accessPolicyId},
          ${item.content},
          ${metadataJson}::jsonb,
          ${nowIso}::timestamptz
        )`;

          await appendSyncChange();

          return {
            item: mapRowToKnowledgeItem(insertedRow),
            versionCreated: true
          };
        }

        existingRows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${item.tenantId}
        AND project_id = ${item.projectId}
        AND id = ${item.id}
      FOR UPDATE`;

        if (!existingRows[0]) {
          throw new Error(
            `KnowledgeItem '${item.id}' already exists in project '${item.projectId}' but is not visible or authorized in the current RLS context; upsert refused (fail-closed).`
          );
        }
      }

      const existing = existingRows[0];
      const isDeleted = existing.deleted_at !== null && existing.deleted_at !== undefined;
      if (
        !isDeleted &&
        existing.content_hash === item.contentHash &&
        existing.status === item.status &&
        Boolean(existing.is_inferred) === Boolean(item.isInferred)
      ) {
        return {
          item: mapRowToKnowledgeItem(existing),
          versionCreated: false
        };
      }

      const validFromIso = item.validFrom ?? parseOptionalIso(existing.valid_from) ?? nowIso;
      const nextVersion = Number(existing.version) + 1;
      const updatedRows = await tx<KnowledgeItemRow>`UPDATE knowledge_items
        SET
          domain_id = ${item.domainId},
          type = ${item.type},
          title = ${item.title},
          content = ${item.content},
          summary = ${summaryParam},
          status = ${item.status},
          source_id = ${item.sourceId},
          source_origin = ${item.sourceOrigin},
          source_kind = ${item.sourceKind},
          source_version = ${item.sourceVersion},
          source_uri = ${item.sourceUri},
          version = ${nextVersion},
          content_hash = ${item.contentHash},
          owner_id = ${ownerIdParam},
          confidence = ${item.confidence},
          trust_level = ${item.trustLevel},
          is_inferred = ${item.isInferred},
          valid_from = ${validFromIso}::timestamptz,
          valid_until = ${validUntilParam}::timestamptz,
          tags = ${item.tags},
          access_policy_id = ${item.accessPolicyId},
          metadata = ${metadataJson}::jsonb,
          deleted_at = NULL,
          updated_at = ${nowIso}::timestamptz
        WHERE tenant_id = ${item.tenantId}
          AND project_id = ${item.projectId}
          AND id = ${item.id}
        RETURNING
          id, tenant_id, project_id, domain_id, type, title, content, summary, status,
          source_id, source_origin, source_kind, source_version, source_uri, version,
          content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
          valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at`;

      const updatedRow = updatedRows[0];
      if (!updatedRow) {
        throw new Error(
          `UPDATE on knowledge_items for '${item.id}' returned no row; refusing to fabricate success (possible RLS divergence between SELECT and UPDATE).`
        );
      }

      await tx`INSERT INTO knowledge_item_versions (
          tenant_id, project_id, item_id, version, domain_id, type, title, summary,
          status, source_origin, source_kind, source_version, content_hash, owner_id,
          confidence, trust_level, is_inferred, tags, access_policy_id, content,
          metadata, created_at
        ) VALUES (
          ${item.tenantId},
          ${item.projectId},
          ${item.id},
          ${nextVersion},
          ${item.domainId},
          ${item.type},
          ${item.title},
          ${summaryParam},
          ${item.status},
          ${item.sourceOrigin},
          ${item.sourceKind},
          ${item.sourceVersion},
          ${item.contentHash},
          ${ownerIdParam},
          ${item.confidence},
          ${item.trustLevel},
          ${item.isInferred},
          ${item.tags},
          ${item.accessPolicyId},
          ${item.content},
          ${metadataJson}::jsonb,
          ${nowIso}::timestamptz
        )`;

      await appendSyncChange();

      return {
        item: mapRowToKnowledgeItem(updatedRow),
        versionCreated: true
      };
    });
  }

  async getItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItem | undefined> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND id = ${normalizedItemId}
        AND deleted_at IS NULL`;

      const row = rows[0];
      if (!row) return undefined;
      return mapRowToKnowledgeItem(row);
    });
  }

  async listSyncSnapshot(
    context: RlsSessionContext,
    projectId: string,
    afterId?: string,
    limit = 100
  ): Promise<KnowledgeItem[]> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedAfterId = afterId === undefined ? null : validateToken(afterId, "afterId");
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND deleted_at IS NULL
        AND (${normalizedAfterId}::text IS NULL OR id > ${normalizedAfterId ?? ""})
      ORDER BY id ASC
      LIMIT ${boundedLimit}`;
      return rows.map(mapRowToKnowledgeItem);
    });
  }

  async listVersions(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItemVersion[]> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemVersionRow>`SELECT
        tenant_id, project_id, item_id, version, domain_id, type, title, summary,
        status, source_origin, source_kind, source_version, content_hash, owner_id,
        confidence, trust_level, is_inferred, tags, access_policy_id, content,
        metadata, created_at
      FROM knowledge_item_versions
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND item_id = ${normalizedItemId}
      ORDER BY version ASC`;

      return rows.map(mapRowToKnowledgeItemVersion);
    });
  }

  async incrementHitCounts(
    context: RlsSessionContext,
    projectId: string,
    itemIds: readonly string[]
  ): Promise<Array<{ itemId: string; hitCount: number }>> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const uniqueIds = [...new Set(itemIds.map((id) => validateToken(id, "itemId")))];
    if (uniqueIds.length === 0) return [];

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<{ item_id: string; hit_count: number | string }>`UPDATE knowledge_items
        SET hit_count = hit_count + 1
        WHERE tenant_id = ${resolved.tenantId}
          AND project_id = ${normalizedProjectId}
          AND id = ANY(${uniqueIds}::text[])
          AND deleted_at IS NULL
        RETURNING id AS item_id, hit_count`;
      if (rows.length !== uniqueIds.length) {
        throw new Error("One or more feedback items are missing or outside the authorized scope.");
      }
      return rows.map((row) => ({ itemId: row.item_id, hitCount: Number(row.hit_count) }));
    });
  }

  async softDeleteItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string,
    deletedAt?: string
  ): Promise<boolean> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const deletedIso = resolveIsoTimestamp(this.now, deletedAt);

    return this.runInRlsTransaction(context, async (tx) => {
      const updated = await tx<{ id: string }>`UPDATE knowledge_items
      SET
        deleted_at = ${deletedIso}::timestamptz,
        updated_at = ${deletedIso}::timestamptz
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND id = ${normalizedItemId}
        AND deleted_at IS NULL
      RETURNING id`;

      if (updated.length === 0) {
        return false;
      }

      await tx`DELETE FROM knowledge_embeddings
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND knowledge_item_id = ${normalizedItemId}`;

      return true;
    });
  }

  async replaceItemEmbeddings(
    context: RlsSessionContext,
    input: ReplaceItemEmbeddingsInput
  ): Promise<number> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, input.projectId);
    const normalizedItemId = validateToken(input.knowledgeItemId, "knowledgeItemId");
    const model = input.embeddingModel ?? "bge-m3";

    return this.runInRlsTransaction(context, async (tx) => {
      await tx`DELETE FROM knowledge_embeddings
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND knowledge_item_id = ${normalizedItemId}`;

      for (const chunk of input.chunks) {
        const vectorLiteral = `[${chunk.embedding.join(",")}]`;
        await tx`INSERT INTO knowledge_embeddings (
          tenant_id, project_id, knowledge_item_id, source_version,
          chunk_index, chunk_text, access_policy_id, embedding_model, embedding
        ) VALUES (
          ${resolved.tenantId}, ${normalizedProjectId}, ${normalizedItemId}, ${input.sourceVersion},
          ${chunk.chunkIndex}, ${chunk.chunkText}, ${input.accessPolicyId}, ${model}, ${vectorLiteral}::vector
        )`;
      }

      return input.chunks.length;
    });
  }
}

export function createPostgresKnowledgeRepository<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
>(
  sqlOrOptions: KnowledgePostgresTarget<TTx> | PostgresKnowledgeRepositoryOptions<TTx>,
  maybeOptions?: { now?: () => Date }
): PostgresKnowledgeRepository<TTx> {
  return new PostgresKnowledgeRepository(sqlOrOptions, maybeOptions);
}

