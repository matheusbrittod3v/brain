import { validateToken, type KnowledgeSqlTransactionRunner } from "./types.js";

export type SystemKnowledgeSqlClient<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> =
  | (TTx & { readonly role?: "brain_system" | string })
  | {
      readonly role?: "brain_system" | string;
      begin<T>(callback: (tx: TTx) => Promise<T> | T): Promise<T>;
    };

export interface PrivacyEraseSubjectInput {
  tenantId: string;
  subjectId: string;
  projectId?: string;
}

export interface PrivacyEraseSubjectResult {
  tenantId: string;
  subjectId: string;
  deletedItems: number;
  deletedItemIds: string[];
  deletedVersions: number;
  deletedEmbeddings: number;
  deletedRelations: number;
  createdSyncTombstones: number;
  deletedMemories: number;
  deletedHandoffs: number;
  deletedRunnerQuestions: number;
  deletedRunnerTasks: number;
  deletedTaskLeases: number;
}

export async function privacyEraseSubject<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
>(
  systemSqlClient: SystemKnowledgeSqlClient<TTx>,
  input: PrivacyEraseSubjectInput
): Promise<PrivacyEraseSubjectResult> {
  if (!systemSqlClient || (typeof systemSqlClient !== "object" && typeof systemSqlClient !== "function")) {
    throw new Error("privacyEraseSubject requires a system SQL client.");
  }
  if ("role" in systemSqlClient && systemSqlClient.role !== undefined && systemSqlClient.role !== "brain_system") {
    throw new Error(
      `privacyEraseSubject requires a 'brain_system' SQL client (received '${String(systemSqlClient.role)}').`
    );
  }

  const normalizedTenantId = validateToken(input.tenantId, "tenantId");
  const normalizedSubjectId = validateToken(input.subjectId, "subjectId");
  const normalizedProjectId =
    input.projectId !== undefined ? validateToken(input.projectId, "projectId") : undefined;

  const runErase = async (tx: TTx): Promise<PrivacyEraseSubjectResult> => {
    const candidates = normalizedProjectId
      ? await tx<{ id: string; project_id: string; content_hash: string; access_policy_id: string }>`
          SELECT id, project_id, content_hash, access_policy_id FROM knowledge_items
          WHERE tenant_id = ${normalizedTenantId}
            AND project_id = ${normalizedProjectId}
            AND (owner_id = ${normalizedSubjectId} OR ${normalizedSubjectId} = ANY(tags))
          FOR UPDATE
        `
      : await tx<{ id: string; project_id: string; content_hash: string; access_policy_id: string }>`
          SELECT id, project_id, content_hash, access_policy_id FROM knowledge_items
          WHERE tenant_id = ${normalizedTenantId}
            AND (owner_id = ${normalizedSubjectId} OR ${normalizedSubjectId} = ANY(tags))
          FOR UPDATE
        `;

    const byProject = new Map<string, string[]>();
    for (const row of candidates) {
      const ids = byProject.get(row.project_id) ?? [];
      ids.push(row.id);
      byProject.set(row.project_id, ids);
    }
    const deletedItemIds: string[] = [];
    let deletedVersions = 0;
    let deletedEmbeddings = 0;
    let deletedRelations = 0;
    let createdSyncTombstones = 0;
    for (const [projectId, itemIds] of byProject) {
      await tx`INSERT INTO sync_project_locks (tenant_id, project_id)
        VALUES (${normalizedTenantId}, ${projectId})
        ON CONFLICT (tenant_id, project_id) DO UPDATE SET locked_at = now()`;
      const embeddings = await tx<{ knowledge_item_id: string }>`
        DELETE FROM knowledge_embeddings
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND knowledge_item_id = ANY(${itemIds}::text[])
        RETURNING knowledge_item_id
      `;
      deletedEmbeddings += embeddings.length;
      const versions = await tx<{ item_id: string }>`
        DELETE FROM knowledge_item_versions
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND item_id = ANY(${itemIds}::text[])
        RETURNING item_id
      `;
      deletedVersions += versions.length;
      const relations = await tx<{ id: string }>`
        DELETE FROM knowledge_relations
        WHERE tenant_id = ${normalizedTenantId}
          AND ((from_project_id = ${projectId} AND from_item_id = ANY(${itemIds}::text[]))
            OR (to_project_id = ${projectId} AND to_item_id = ANY(${itemIds}::text[])))
        RETURNING id
      `;
      deletedRelations += relations.length;
      const tombstones = await tx<{ sync_seq: number }>`
        INSERT INTO sync_changes (tenant_id, project_id, item_id, content_hash, access_policy_id, deleted_at)
        SELECT tenant_id, project_id, id, content_hash, access_policy_id, now()
        FROM knowledge_items
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND id = ANY(${itemIds}::text[])
        RETURNING sync_seq
      `;
      createdSyncTombstones += tombstones.length;
      const deleted = await tx<{ id: string }>`
        DELETE FROM knowledge_items
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND id = ANY(${itemIds}::text[])
        RETURNING id
      `;
      deletedItemIds.push(...deleted.map((row) => row.id));
    }

    const memories = await tx<{ id: string }>`
      DELETE FROM memory_entries WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING id
    `;
    const handoffRows = await tx<{ task_id: string }>`
      DELETE FROM handoffs WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING task_id
    `;
    const tasks = await tx<{ task_id: string }>`
      DELETE FROM runner_tasks WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING task_id
    `;
    const taskIds = tasks.map((row) => row.task_id);
    let deletedRunnerQuestions = 0;
    let deletedTaskLeases = 0;
    if (taskIds.length > 0) {
      const questions = await tx<{ question_id: string }>`
        DELETE FROM runner_task_questions WHERE tenant_id = ${normalizedTenantId}
          AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${taskIds}::text[])
        RETURNING question_id
      `;
      deletedRunnerQuestions = questions.length;
      const leases = await tx<{ task_id: string }>`
        DELETE FROM task_leases WHERE tenant_id = ${normalizedTenantId}
          AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${taskIds}::text[])
        RETURNING task_id
      `;
      deletedTaskLeases = leases.length;
    }
    const handoffTaskIds = handoffRows.map((row) => row.task_id);
    const orphanHandoffLeases = handoffTaskIds.length ? await tx<{ task_id: string }>`
      DELETE FROM task_leases WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${handoffTaskIds}::text[])
      RETURNING task_id
    ` : [];
    deletedTaskLeases += orphanHandoffLeases.length;

    return {
      tenantId: normalizedTenantId,
      subjectId: normalizedSubjectId,
      deletedItems: deletedItemIds.length,
      deletedItemIds,
      deletedVersions,
      deletedEmbeddings,
      deletedRelations,
      createdSyncTombstones,
      deletedMemories: memories.length,
      deletedHandoffs: handoffRows.length,
      deletedRunnerQuestions,
      deletedRunnerTasks: tasks.length,
      deletedTaskLeases
    };
  };

  if ("begin" in systemSqlClient && typeof systemSqlClient.begin === "function") {
    return systemSqlClient.begin(runErase);
  }

  return runErase(systemSqlClient as TTx);
}

