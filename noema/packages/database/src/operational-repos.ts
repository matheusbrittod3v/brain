import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthContext } from "@noema/auth";
import {
  BrainError,
  validateContextSessionId,
  type ContextSessionEvidence,
  type ContextSessionHitRate,
  type ContextSessionItemInput
} from "@noema/core";
import { withTenantRls, type NoemaDb } from "./client.js";
import {
  crossServiceContracts,
  auditLogs,
  developerProfiles,
  handoffs,
  integrationEvents,
  knowledgeRelations,
  memoryEntries,
  runnerTasks,
  runnerTaskQuestions,
  approvalReminderEvents,
  approvalRequests,
  contextSessionItems,
  customAccessPolicies,
  knowledgeItems,
  notificationPreferences,
  notificationOutbox,
  projectAccessMembers,
  testExecutionResults,
  syncChanges,
  syncProjectLocks,
  policyEpochStates,
  gitIngestionHeads,
  projectRepositoryHeads,
  taskLeases,
  temporaryAccessGrants,
  departmentFinopsQuotas,
  integrationFallbackOwners,
  integrationReconnectHistory,
  lgpdShreddedSubjects
} from "./schema.js";

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "organizational";

async function getContextHitRateInTransaction(
  tx: NoemaDb,
  ctx: AuthContext,
  projectId: string,
  sessionId: string
): Promise<ContextSessionHitRate> {
  const rows = await tx.execute(sql`
    SELECT
      count(*)::int AS items_sent,
      count(*) FILTER (WHERE hit_at IS NOT NULL)::int AS hits
    FROM public.context_session_items
    WHERE tenant_id = ${ctx.tenantId}
      AND project_id = ${projectId}
      AND actor_id = ${ctx.actorId}
      AND session_id = ${sessionId}
  `);
  const itemsSent = Number(rows[0]?.items_sent ?? 0);
  const hits = Number(rows[0]?.hits ?? 0);
  return { sessionId, hits, itemsSent, rate: itemsSent > 0 ? hits / itemsSent : 0 };
}

async function recordContextEvidenceInTransaction(
  tx: NoemaDb,
  ctx: AuthContext,
  projectId: string,
  sessionId: string,
  itemIds: readonly string[],
  evidence: ContextSessionEvidence
): Promise<Array<{ itemId: string; accessPolicyId: string }>> {
  if (!(["read", "citation", "edit"] as string[]).includes(evidence)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Unknown Context Session evidence type.", 400);
  }
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return [];
  const rows = await tx.select({
    itemId: contextSessionItems.itemId,
    accessPolicyId: contextSessionItems.accessPolicyId,
    hitAt: contextSessionItems.hitAt
  }).from(contextSessionItems).where(and(
    eq(contextSessionItems.tenantId, ctx.tenantId),
    eq(contextSessionItems.projectId, projectId),
    eq(contextSessionItems.actorId, ctx.actorId),
    eq(contextSessionItems.sessionId, sessionId),
    inArray(contextSessionItems.itemId, uniqueIds)
  )).for("update");
  if (rows.length !== uniqueIds.length) {
    throw new BrainError("BRAIN_ERR_NOT_FOUND", "One or more items were not delivered in this authorized Context Pack session.", 404);
  }
  const newlyHit = rows.filter((row) => row.hitAt === null).map(({ itemId, accessPolicyId }) => ({ itemId, accessPolicyId }));
  await tx.update(contextSessionItems).set({
    hitAt: sql`COALESCE(${contextSessionItems.hitAt}, now())`,
    hitEvidence: sql`CASE WHEN ${evidence} = ANY(${contextSessionItems.hitEvidence}) THEN ${contextSessionItems.hitEvidence} ELSE array_append(${contextSessionItems.hitEvidence}, ${evidence}) END`
  }).where(and(
    eq(contextSessionItems.tenantId, ctx.tenantId),
    eq(contextSessionItems.projectId, projectId),
    eq(contextSessionItems.actorId, ctx.actorId),
    eq(contextSessionItems.sessionId, sessionId),
    inArray(contextSessionItems.itemId, uniqueIds)
  ));

  if (newlyHit.length > 0) {
    const updated = await tx.update(knowledgeItems)
      .set({ contextHitCount: sql`${knowledgeItems.contextHitCount} + 1` })
      .where(and(
        eq(knowledgeItems.tenantId, ctx.tenantId),
        eq(knowledgeItems.projectId, projectId),
        inArray(knowledgeItems.id, newlyHit.map((row) => row.itemId)),
        isNull(knowledgeItems.deletedAt)
      ))
      .returning({ itemId: knowledgeItems.id });
    if (updated.length !== newlyHit.length) throw new BrainError("BRAIN_ERR_NOT_FOUND", "Context feedback could not update every authorized item.", 404);

    const hitItems = await tx.select({
      itemId: contextSessionItems.itemId,
      accessPolicyId: contextSessionItems.accessPolicyId
    }).from(contextSessionItems).where(and(
      eq(contextSessionItems.tenantId, ctx.tenantId),
      eq(contextSessionItems.projectId, projectId),
      eq(contextSessionItems.actorId, ctx.actorId),
      eq(contextSessionItems.sessionId, sessionId),
      sql`${contextSessionItems.hitAt} IS NOT NULL`
    ));
    const newIds = new Set(newlyHit.map((row) => row.itemId));
    const pairKeys = new Set<string>();
    for (const fresh of newlyHit) {
      for (const hit of hitItems) {
        if (fresh.itemId === hit.itemId) continue;
        const [left, right] = [fresh.itemId, hit.itemId].sort();
        if (newIds.has(hit.itemId) && hit.itemId !== left) continue;
        const pairKey = `${left}\u0000${right}`;
        if (pairKeys.has(pairKey)) continue;
        pairKeys.add(pairKey);
        const leftItem = left === fresh.itemId ? fresh : hit;
        const rightItem = right === fresh.itemId ? fresh : hit;
        for (const [from, to] of [[leftItem, rightItem], [rightItem, leftItem]]) {
          await tx.execute(sql`
            INSERT INTO public.knowledge_relations (
              tenant_id, from_project_id, to_project_id, from_item_id, to_item_id,
              from_policy_id, to_policy_id, relation_type, is_inferred, confidence
            ) VALUES (
              ${ctx.tenantId}, ${projectId}, ${projectId}, ${from.itemId}, ${to.itemId},
              ${from.accessPolicyId}, ${to.accessPolicyId}, 'CO_ACCESSED_WITH', true, 0.5
            )
            ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO UPDATE
              SET confidence = LEAST(1.0, knowledge_relations.confidence + 0.1), created_at = now()
              WHERE knowledge_relations.is_inferred AND EXCLUDED.is_inferred
          `);
        }
      }
    }
  }
  return newlyHit;
}

export class PgOperationalRepository {
  constructor(private readonly db: NoemaDb) {}

  private assertAccessAdminScope(ctx: AuthContext, projectId: string): void {
    if (!ctx.allowedProjects.includes(projectId) || !ctx.allowedPolicies.includes("internal-project")) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Access administration is outside the authorized project or policy scope.", 403);
    }
  }

  async listAccessMembers(ctx: AuthContext, projectId: string) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      actorId: projectAccessMembers.actorId,
      roles: projectAccessMembers.roles,
      allowedPolicies: projectAccessMembers.allowedPolicies,
      updatedAt: projectAccessMembers.updatedAt,
      syncedWithKeycloak: projectAccessMembers.syncedWithKeycloak
    }).from(projectAccessMembers).where(and(
      eq(projectAccessMembers.tenantId, ctx.tenantId),
      eq(projectAccessMembers.projectId, projectId),
      eq(projectAccessMembers.accessPolicyId, "internal-project")
    )).orderBy(asc(projectAccessMembers.actorId)));
  }

  async saveAccessMember(
    ctx: AuthContext,
    projectId: string,
    input: { actorId: string; roles: string[]; allowedPolicies: string[]; syncedWithKeycloak: boolean }
  ) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(projectAccessMembers).values({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: input.actorId,
        roles: [...new Set(input.roles)],
        allowedPolicies: [...new Set(input.allowedPolicies)],
        syncedWithKeycloak: input.syncedWithKeycloak,
        updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [projectAccessMembers.tenantId, projectAccessMembers.projectId, projectAccessMembers.actorId],
        set: {
          roles: [...new Set(input.roles)],
          allowedPolicies: [...new Set(input.allowedPolicies)],
          syncedWithKeycloak: input.syncedWithKeycloak,
          updatedAt: new Date()
        }
      }).returning({
        actorId: projectAccessMembers.actorId,
        roles: projectAccessMembers.roles,
        allowedPolicies: projectAccessMembers.allowedPolicies,
        updatedAt: projectAccessMembers.updatedAt,
        syncedWithKeycloak: projectAccessMembers.syncedWithKeycloak
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Member access record was not persisted.", 503);
      return row;
    });
  }

  async listTemporaryAccessGrants(ctx: AuthContext, projectId: string, at = new Date()) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      grantId: temporaryAccessGrants.grantId,
      projectId: temporaryAccessGrants.projectId,
      actorId: temporaryAccessGrants.actorId,
      roles: temporaryAccessGrants.roles,
      policyIds: temporaryAccessGrants.policyIds,
      expiresAt: temporaryAccessGrants.expiresAt,
      grantedBy: temporaryAccessGrants.grantedBy,
      createdAt: temporaryAccessGrants.createdAt
    }).from(temporaryAccessGrants).where(and(
      eq(temporaryAccessGrants.tenantId, ctx.tenantId),
      eq(temporaryAccessGrants.projectId, projectId),
      eq(temporaryAccessGrants.accessPolicyId, "internal-project"),
      gt(temporaryAccessGrants.expiresAt, at)
    )).orderBy(asc(temporaryAccessGrants.createdAt)));
  }

  async createTemporaryAccessGrant(ctx: AuthContext, input: {
    grantId: string; projectId: string; actorId: string; roles: string[]; policyIds: string[]; expiresAt: Date; grantedBy: string;
  }) {
    this.assertAccessAdminScope(ctx, input.projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(temporaryAccessGrants).values({
        grantId: input.grantId,
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        accessPolicyId: "internal-project",
        actorId: input.actorId,
        roles: [...new Set(input.roles)],
        policyIds: [...new Set(input.policyIds)],
        expiresAt: input.expiresAt,
        grantedBy: input.grantedBy
      }).returning({
        grantId: temporaryAccessGrants.grantId,
        projectId: temporaryAccessGrants.projectId,
        actorId: temporaryAccessGrants.actorId,
        roles: temporaryAccessGrants.roles,
        policyIds: temporaryAccessGrants.policyIds,
        expiresAt: temporaryAccessGrants.expiresAt,
        grantedBy: temporaryAccessGrants.grantedBy,
        createdAt: temporaryAccessGrants.createdAt
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Temporary access grant was not persisted.", 503);
      return row;
    });
  }

  async revokeTemporaryAccessGrant(ctx: AuthContext, projectId: string, grantId: string): Promise<boolean> {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx.delete(temporaryAccessGrants).where(and(
        eq(temporaryAccessGrants.tenantId, ctx.tenantId),
        eq(temporaryAccessGrants.projectId, projectId),
        eq(temporaryAccessGrants.grantId, grantId),
        eq(temporaryAccessGrants.accessPolicyId, "internal-project")
      )).returning({ grantId: temporaryAccessGrants.grantId });
      return deleted.length > 0;
    });
  }

  async listCustomAccessPolicies(ctx: AuthContext, projectId: string) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      policyId: customAccessPolicies.policyId,
      label: customAccessPolicies.label,
      description: customAccessPolicies.description,
      allowedRoles: customAccessPolicies.allowedRoles,
      updatedAt: customAccessPolicies.updatedAt
    }).from(customAccessPolicies).where(and(
      eq(customAccessPolicies.tenantId, ctx.tenantId),
      eq(customAccessPolicies.projectId, projectId),
      eq(customAccessPolicies.accessPolicyId, "internal-project")
    )).orderBy(asc(customAccessPolicies.policyId)));
  }

  async upsertCustomAccessPolicy(ctx: AuthContext, projectId: string, input: {
    policyId: string; label: string; description: string; allowedRoles: string[];
  }) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(customAccessPolicies).values({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        policyId: input.policyId,
        label: input.label,
        description: input.description,
        allowedRoles: [...new Set(input.allowedRoles)],
        updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [customAccessPolicies.tenantId, customAccessPolicies.projectId, customAccessPolicies.policyId],
        set: {
          accessPolicyId: "internal-project",
          label: input.label,
          description: input.description,
          allowedRoles: [...new Set(input.allowedRoles)],
          updatedAt: new Date()
        }
      }).returning({
        policyId: customAccessPolicies.policyId,
        label: customAccessPolicies.label,
        description: customAccessPolicies.description,
        allowedRoles: customAccessPolicies.allowedRoles,
        updatedAt: customAccessPolicies.updatedAt
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Custom access policy was not persisted.", 503);
      return row;
    });
  }

  async recordContextDelivery(
    ctx: AuthContext,
    projectId: string,
    rawSessionId: string,
    items: readonly ContextSessionItemInput[]
  ): Promise<ContextSessionHitRate> {
    const sessionId = validateContextSessionId(rawSessionId);
    if (!ctx.allowedProjects.includes(projectId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Project is outside the authorized context.", 403);
    const byId = new Map<string, ContextSessionItemInput>();
    for (const item of items) {
      const normalized = { ...item, itemId: item.itemId.trim(), accessPolicyId: item.accessPolicyId.trim(), sourceUri: item.sourceUri.trim(), sourceHash: item.sourceHash?.trim().toLowerCase() };
      if (!normalized.itemId || !normalized.sourceUri || !ctx.allowedPolicies.includes(normalized.accessPolicyId)) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "A Context Pack source is missing or outside the authorized policy scope.", 403);
      }
      if (normalized.sourceHash && !/^[a-f0-9]{64}$/.test(normalized.sourceHash)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Context source hash must be a SHA-256 hex digest.", 400);
      }
      const prior = byId.get(normalized.itemId);
      if (prior && (prior.accessPolicyId !== normalized.accessPolicyId || prior.sourceUri !== normalized.sourceUri)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Context Pack item '${normalized.itemId}' has conflicting source metadata.`, 409);
      }
      byId.set(normalized.itemId, normalized);
    }
    const uniqueItems = [...byId.values()];
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      if (uniqueItems.length > 0) {
        const visibleItems = await tx.select({ id: knowledgeItems.id, accessPolicyId: knowledgeItems.accessPolicyId })
          .from(knowledgeItems)
          .where(and(
            eq(knowledgeItems.tenantId, ctx.tenantId),
            eq(knowledgeItems.projectId, projectId),
            inArray(knowledgeItems.id, uniqueItems.map((item) => item.itemId)),
            isNull(knowledgeItems.deletedAt)
          ));
        if (visibleItems.length !== uniqueItems.length || uniqueItems.some((item) => !visibleItems.some((visible) => visible.id === item.itemId && visible.accessPolicyId === item.accessPolicyId))) {
          throw new BrainError("BRAIN_ERR_NOT_FOUND", "One or more Context Pack sources are missing or outside the authorized scope.", 404);
        }
        const inserted = await tx.insert(contextSessionItems).values(uniqueItems.map((item) => ({
          tenantId: ctx.tenantId,
          projectId,
          actorId: ctx.actorId,
          sessionId,
          itemId: item.itemId,
          accessPolicyId: item.accessPolicyId,
          sourceUri: item.sourceUri,
          sourceHash: item.sourceHash ?? null,
          taskId: item.taskId ?? null
        }))).onConflictDoNothing().returning({ itemId: contextSessionItems.itemId });
        const persisted = await tx.select({
          itemId: contextSessionItems.itemId,
          accessPolicyId: contextSessionItems.accessPolicyId,
          sourceUri: contextSessionItems.sourceUri,
          taskId: contextSessionItems.taskId
        }).from(contextSessionItems).where(and(
          eq(contextSessionItems.tenantId, ctx.tenantId),
          eq(contextSessionItems.projectId, projectId),
          eq(contextSessionItems.actorId, ctx.actorId),
          eq(contextSessionItems.sessionId, sessionId),
          inArray(contextSessionItems.itemId, uniqueItems.map((item) => item.itemId))
        ));
        if (persisted.length !== uniqueItems.length || uniqueItems.some((item) => !persisted.some((row) =>
          row.itemId === item.itemId && row.accessPolicyId === item.accessPolicyId && row.sourceUri === item.sourceUri && row.taskId === (item.taskId ?? null)
        ))) {
          throw new BrainError("BRAIN_ERR_CONFLICT", "This session already recorded a Context Pack item with different scope or task metadata.", 409);
        }
        if (inserted.length > 0) {
          const updated = await tx.update(knowledgeItems)
            .set({ contextSentCount: sql`${knowledgeItems.contextSentCount} + 1` })
            .where(and(
              eq(knowledgeItems.tenantId, ctx.tenantId),
              eq(knowledgeItems.projectId, projectId),
              inArray(knowledgeItems.id, inserted.map((row) => row.itemId)),
              isNull(knowledgeItems.deletedAt)
            ))
            .returning({ itemId: knowledgeItems.id });
          if (updated.length !== inserted.length) throw new BrainError("BRAIN_ERR_NOT_FOUND", "Context Pack delivery could not update every authorized item.", 404);
        }
      }
      return getContextHitRateInTransaction(tx, ctx, projectId, sessionId);
    });
  }

  async getContextEditCandidates(
    ctx: AuthContext,
    projectId: string,
    rawSessionId: string,
    taskId: string
  ): Promise<Array<{ sourceUri: string; sourceHash: string }>> {
    const sessionId = validateContextSessionId(rawSessionId);
    if (!ctx.allowedProjects.includes(projectId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Project is outside the authorized context.", 403);
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.select({ sourceUri: contextSessionItems.sourceUri, sourceHash: contextSessionItems.sourceHash })
        .from(contextSessionItems)
        .where(and(
          eq(contextSessionItems.tenantId, ctx.tenantId),
          eq(contextSessionItems.projectId, projectId),
          eq(contextSessionItems.actorId, ctx.actorId),
          eq(contextSessionItems.sessionId, sessionId),
          eq(contextSessionItems.taskId, taskId),
          isNotNull(contextSessionItems.sourceHash)
        ))
        .orderBy(asc(contextSessionItems.sourceUri));
      return rows.flatMap((row) => typeof row.sourceHash === "string"
        ? [{ sourceUri: row.sourceUri, sourceHash: row.sourceHash }]
        : []);
    });
  }

  async recordContextEvidence(
    ctx: AuthContext,
    projectId: string,
    rawSessionId: string,
    itemIds: readonly string[],
    evidence: ContextSessionEvidence
  ): Promise<{ rate: ContextSessionHitRate; newlyHit: Array<{ itemId: string; accessPolicyId: string }> }> {
    const sessionId = validateContextSessionId(rawSessionId);
    const uniqueIds = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
    if (!ctx.allowedProjects.includes(projectId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Project is outside the authorized context.", 403);
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const newlyHit = await recordContextEvidenceInTransaction(tx, ctx, projectId, sessionId, uniqueIds, evidence);
      return { rate: await getContextHitRateInTransaction(tx, ctx, projectId, sessionId), newlyHit };
    });
  }

  async recordContextEdits(
    ctx: AuthContext,
    projectId: string,
    rawSessionId: string,
    taskId: string,
    editedPaths: readonly string[]
  ): Promise<{ rate: ContextSessionHitRate; newlyHit: Array<{ itemId: string; accessPolicyId: string }>; matchedPaths: string[] }> {
    const sessionId = validateContextSessionId(rawSessionId);
    if (!ctx.allowedProjects.includes(projectId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Project is outside the authorized context.", 403);
    const paths = [...new Set(editedPaths.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean))];
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const activeLease = await tx.select({ taskId: taskLeases.taskId })
        .from(taskLeases)
        .where(and(
          eq(taskLeases.tenantId, ctx.tenantId),
          eq(taskLeases.projectId, projectId),
          eq(taskLeases.taskId, taskId),
          eq(taskLeases.actorId, ctx.actorId),
          gt(taskLeases.expiresAt, new Date())
        ))
        .for("update")
        .limit(1);
      if (activeLease.length === 0) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Edit evidence requires an active task lease held by the authenticated actor.", 403);
      }
      const delivered = paths.length === 0 ? [] : await tx.select({ itemId: contextSessionItems.itemId, sourceUri: contextSessionItems.sourceUri })
        .from(contextSessionItems)
        .where(and(
          eq(contextSessionItems.tenantId, ctx.tenantId),
          eq(contextSessionItems.projectId, projectId),
          eq(contextSessionItems.actorId, ctx.actorId),
          eq(contextSessionItems.sessionId, sessionId),
          eq(contextSessionItems.taskId, taskId),
          inArray(contextSessionItems.sourceUri, paths)
        ));
      const newlyHit = await recordContextEvidenceInTransaction(
        tx, ctx, projectId, sessionId, delivered.map((row) => row.itemId), "edit"
      );
      return {
        rate: await getContextHitRateInTransaction(tx, ctx, projectId, sessionId),
        newlyHit,
        matchedPaths: [...new Set(delivered.map((row) => row.sourceUri))]
      };
    });
  }

  async getContextHitRate(ctx: AuthContext, projectId: string, rawSessionId: string): Promise<ContextSessionHitRate> {
    const sessionId = validateContextSessionId(rawSessionId);
    if (!ctx.allowedProjects.includes(projectId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Project is outside the authorized context.", 403);
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      return getContextHitRateInTransaction(tx, ctx, projectId, sessionId);
    });
  }

  async updatePolicyEpoch(
    ctx: AuthContext,
    projectId: string,
    revokedPolicies: string[],
    allowedPolicies = ctx.allowedPolicies
  ): Promise<number> {
    // PostgreSQL text cannot contain NUL bytes. JSON keeps the sorted list
    // unambiguous while remaining valid text for persistent fingerprints.
    const fingerprint = revokedPolicies.length > 0 ? JSON.stringify([...new Set(revokedPolicies)].sort()) : null;
    const allowedPolicyFingerprint = JSON.stringify([...new Set(allowedPolicies)].sort());
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.insert(policyEpochStates).values({
        tenantId: ctx.tenantId,
        projectId,
        actorId: ctx.actorId,
        epoch: fingerprint ? 2 : 1,
        revocationFingerprint: fingerprint,
        allowedPolicyFingerprint,
        updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [policyEpochStates.tenantId, policyEpochStates.projectId, policyEpochStates.actorId],
        set: {
          epoch: sql`CASE WHEN (
            (${policyEpochStates.revocationFingerprint} IS DISTINCT FROM excluded.revocation_fingerprint
              AND excluded.revocation_fingerprint IS NOT NULL)
            OR ${policyEpochStates.allowedPolicyFingerprint} IS DISTINCT FROM excluded.allowed_policy_fingerprint
          ) THEN ${policyEpochStates.epoch} + 1 ELSE ${policyEpochStates.epoch} END`,
          revocationFingerprint: fingerprint,
          allowedPolicyFingerprint,
          updatedAt: new Date()
        }
      }).returning({ epoch: policyEpochStates.epoch });
      return rows[0]?.epoch ?? 1;
    });
  }

  async recordRunnerTokenUsage(tenantId: string, projectId: string, tokens: number, dailyLimit = 100_000, at = new Date()) {
    const usageDate = at.toISOString().slice(0, 10);
    const result = await this.db.execute(sql`
      INSERT INTO public.runner_token_usage_daily (tenant_id, project_id, usage_date, used_tokens, updated_at)
      VALUES (${tenantId}, ${projectId}, ${usageDate}::date, ${tokens}, now())
      ON CONFLICT (tenant_id, project_id, usage_date) DO UPDATE
        SET used_tokens = runner_token_usage_daily.used_tokens + EXCLUDED.used_tokens, updated_at = now()
      RETURNING used_tokens
    `);
    const used = Number(result[0]?.used_tokens ?? 0);
    return { allowed: used <= dailyLimit, used, limit: dailyLimit };
  }

  async getNotificationPreferences(ctx: AuthContext, projectId: string, accessPolicyId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.select().from(notificationPreferences).where(and(
        eq(notificationPreferences.tenantId, ctx.tenantId), eq(notificationPreferences.projectId, projectId),
        eq(notificationPreferences.actorId, ctx.actorId), eq(notificationPreferences.accessPolicyId, accessPolicyId)
      )).limit(1);
      return rows[0];
    });
  }

  async saveNotificationPreferences(ctx: AuthContext, input: {
    projectId: string; accessPolicyId: string; channels: string[]; categories: string[]; frequency: string;
  }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.insert(notificationPreferences).values({
        tenantId: ctx.tenantId, projectId: input.projectId, actorId: ctx.actorId,
        accessPolicyId: input.accessPolicyId, channels: input.channels,
        categories: input.categories, frequency: input.frequency, updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [notificationPreferences.tenantId, notificationPreferences.projectId, notificationPreferences.actorId, notificationPreferences.accessPolicyId],
        set: { channels: input.channels, categories: input.categories, frequency: input.frequency, updatedAt: new Date() }
      }).returning();
      return rows[0];
    });
  }

  async clearNotificationPreferences(ctx: AuthContext, projectId: string, accessPolicyId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.delete(notificationPreferences).where(and(
        eq(notificationPreferences.tenantId, ctx.tenantId), eq(notificationPreferences.projectId, projectId),
        eq(notificationPreferences.actorId, ctx.actorId), eq(notificationPreferences.accessPolicyId, accessPolicyId)
      )).returning({ id: notificationPreferences.id });
      return rows.length > 0;
    });
  }

  async enqueueNotificationDigest(ctx: AuthContext, input: {
    projectId: string; accessPolicyId: string; channel: string; category: string;
    eventKey: string; payload: Record<string, unknown>; scheduledAt: Date;
  }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.insert(notificationOutbox).values({
        tenantId: ctx.tenantId, projectId: input.projectId, actorId: ctx.actorId,
        accessPolicyId: input.accessPolicyId, channel: input.channel, category: input.category,
        eventKey: input.eventKey, payload: input.payload, scheduledAt: input.scheduledAt
      }).onConflictDoNothing().returning({ id: notificationOutbox.id });
      return rows.length > 0;
    });
  }

  async listNotificationDigest(ctx: AuthContext, input: { projectId: string; accessPolicyId: string; channel: string; category: string; scheduledAt: Date }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      return tx.select().from(notificationOutbox).where(and(
        eq(notificationOutbox.tenantId, ctx.tenantId), eq(notificationOutbox.projectId, input.projectId),
        eq(notificationOutbox.actorId, ctx.actorId), eq(notificationOutbox.accessPolicyId, input.accessPolicyId),
        eq(notificationOutbox.channel, input.channel), eq(notificationOutbox.category, input.category),
        eq(notificationOutbox.scheduledAt, input.scheduledAt), sql`${notificationOutbox.deliveredAt} IS NULL`
      ));
    });
  }

  async markNotificationDigestDelivered(ctx: AuthContext, ids: string[]) {
    if (ids.length === 0) return 0;
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_actor_id', ${ctx.actorId}, true)`);
      const rows = await tx.update(notificationOutbox).set({ deliveredAt: new Date() }).where(and(
        eq(notificationOutbox.tenantId, ctx.tenantId), inArray(notificationOutbox.id, ids), sql`${notificationOutbox.deliveredAt} IS NULL`
      )).returning({ id: notificationOutbox.id });
      return rows.length;
    });
  }

  async recordApprovalReminder(ctx: AuthContext, input: { projectId: string; proposalId: string; accessPolicyId: string; dueAt: Date; eventType: "reminder" | "escalation" }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const stillPending = await tx.select({ proposalId: approvalRequests.proposalId }).from(approvalRequests).where(and(
        eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.projectId, input.projectId),
        eq(approvalRequests.proposalId, input.proposalId), eq(approvalRequests.accessPolicyId, input.accessPolicyId),
        eq(approvalRequests.status, "pending"), eq(approvalRequests.dueAt, input.dueAt)
      )).limit(1);
      if (!stillPending.length) return false;
      const inserted = await tx.insert(approvalReminderEvents).values({
        tenantId: ctx.tenantId, projectId: input.projectId, proposalId: input.proposalId,
        accessPolicyId: input.accessPolicyId, dueAt: input.dueAt, eventType: input.eventType
      }).onConflictDoNothing().returning({ id: approvalReminderEvents.id });
      return inserted.length > 0;
    });
  }

  async listApprovalReminderEvents(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => tx.select().from(approvalReminderEvents).where(and(
      eq(approvalReminderEvents.tenantId, ctx.tenantId), eq(approvalReminderEvents.projectId, projectId),
      inArray(approvalReminderEvents.accessPolicyId, ctx.allowedPolicies)
    )).orderBy(desc(approvalReminderEvents.createdAt)));
  }

  async listProposalAuditHistory(ctx: AuthContext, projectId: string, proposalId: string) {
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      actorId: auditLogs.actorId,
      actorType: auditLogs.actorType,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt
    }).from(auditLogs).where(and(
      eq(auditLogs.tenantId, ctx.tenantId),
      eq(auditLogs.projectId, projectId),
      eq(auditLogs.targetId, proposalId),
      inArray(auditLogs.accessPolicyId, ctx.allowedPolicies)
    )).orderBy(auditLogs.createdAt));
  }

  async recordTestExecutionResults(ctx: AuthContext, input: {
    projectId: string; provider: string; runId: string; commitSha: string;
    repository?: string;
    receivedBy: string; executedAt: Date;
    results: Array<{ testItemId: string; accessPolicyId: string; status: "passed" | "failed" | "skipped"; durationMs: number | null }>;
  }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      let duplicateCount = 0;
      for (const result of input.results) {
        const row = {
          tenantId: ctx.tenantId, projectId: input.projectId, accessPolicyId: result.accessPolicyId,
          repository: input.repository ?? null,
          provider: input.provider, runId: input.runId, testItemId: result.testItemId,
          commitSha: input.commitSha, status: result.status, durationMs: result.durationMs,
          executedAt: input.executedAt, receivedBy: input.receivedBy
        };
        const inserted = await tx.insert(testExecutionResults).values(row).onConflictDoNothing().returning({ id: testExecutionResults.id });
        if (inserted.length) continue;
        const existingRows = await tx.select().from(testExecutionResults).where(and(
          eq(testExecutionResults.tenantId, ctx.tenantId), eq(testExecutionResults.projectId, input.projectId),
          eq(testExecutionResults.provider, input.provider), eq(testExecutionResults.runId, input.runId),
          eq(testExecutionResults.testItemId, result.testItemId)
        )).limit(1);
        const existing = existingRows[0];
        if (!existing || existing.repository !== row.repository || existing.commitSha !== row.commitSha || existing.status !== row.status || existing.durationMs !== row.durationMs || existing.accessPolicyId !== row.accessPolicyId) {
          throw new BrainError("BRAIN_ERR_CONFLICT", `Execução '${input.runId}' já foi registrada com resultado diferente para '${result.testItemId}'.`, 409);
        }
        duplicateCount++;
      }
      return { acceptedCount: input.results.length - duplicateCount, duplicateCount };
    });
  }

  async upsertGitHubMainHead(ctx: AuthContext, input: {
    projectId: string; repository: string; commitSha: string; accessPolicyId: string; beforeCommitSha?: string;
  }) {
    return withTenantRls(this.db, ctx, async (tx) => tx.insert(projectRepositoryHeads).values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      repository: input.repository.toLowerCase(),
      branch: "main",
      commitSha: input.commitSha.toLowerCase(),
      accessPolicyId: input.accessPolicyId,
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: [projectRepositoryHeads.tenantId, projectRepositoryHeads.projectId, projectRepositoryHeads.repository, projectRepositoryHeads.branch],
      set: { commitSha: input.commitSha.toLowerCase(), accessPolicyId: input.accessPolicyId, updatedAt: new Date() },
      where: input.beforeCommitSha
        ? eq(projectRepositoryHeads.commitSha, input.beforeCommitSha.toLowerCase())
        : sql`false`
    }).returning());
  }

  async listGitHubMainHeads(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => tx.select().from(projectRepositoryHeads).where(and(
      eq(projectRepositoryHeads.tenantId, ctx.tenantId),
      eq(projectRepositoryHeads.projectId, projectId),
      eq(projectRepositoryHeads.branch, "main")
    )));
  }

  async deleteGitHubMainHead(ctx: AuthContext, input: { projectId: string; repository: string; beforeCommitSha?: string }) {
    return withTenantRls(this.db, ctx, async (tx) => tx.delete(projectRepositoryHeads).where(and(
      eq(projectRepositoryHeads.tenantId, ctx.tenantId),
      eq(projectRepositoryHeads.projectId, input.projectId),
      eq(projectRepositoryHeads.repository, input.repository.toLowerCase()),
      eq(projectRepositoryHeads.branch, "main"),
      ...(input.beforeCommitSha ? [eq(projectRepositoryHeads.commitSha, input.beforeCommitSha.toLowerCase())] : [])
    )).returning({ repository: projectRepositoryHeads.repository }));
  }

  async upsertGitHubRefHead(ctx: AuthContext, input: {
    projectId: string; repository: string; branch: string; commitSha: string; accessPolicyId: string; beforeCommitSha?: string;
  }) {
    return withTenantRls(this.db, ctx, async (tx) => tx.insert(projectRepositoryHeads).values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      repository: input.repository.toLowerCase(),
      branch: input.branch,
      commitSha: input.commitSha.toLowerCase(),
      accessPolicyId: input.accessPolicyId,
      updatedAt: new Date()
    }).onConflictDoUpdate({
      target: [projectRepositoryHeads.tenantId, projectRepositoryHeads.projectId, projectRepositoryHeads.repository, projectRepositoryHeads.branch],
      set: { commitSha: input.commitSha.toLowerCase(), accessPolicyId: input.accessPolicyId, updatedAt: new Date() },
      where: input.beforeCommitSha
        ? eq(projectRepositoryHeads.commitSha, input.beforeCommitSha.toLowerCase())
        : sql`false`
    }).returning());
  }

  async getGitHubRefHead(ctx: AuthContext, input: { projectId: string; repository: string; branch: string }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx.select().from(projectRepositoryHeads).where(and(
        eq(projectRepositoryHeads.tenantId, ctx.tenantId),
        eq(projectRepositoryHeads.projectId, input.projectId),
        eq(projectRepositoryHeads.repository, input.repository.toLowerCase()),
        eq(projectRepositoryHeads.branch, input.branch)
      )).limit(1);
      return rows[0];
    });
  }

  async deleteGitHubRefHead(ctx: AuthContext, input: { projectId: string; repository: string; branch: string; beforeCommitSha?: string }) {
    return withTenantRls(this.db, ctx, async (tx) => tx.delete(projectRepositoryHeads).where(and(
      eq(projectRepositoryHeads.tenantId, ctx.tenantId),
      eq(projectRepositoryHeads.projectId, input.projectId),
      eq(projectRepositoryHeads.repository, input.repository.toLowerCase()),
      eq(projectRepositoryHeads.branch, input.branch),
      ...(input.beforeCommitSha ? [eq(projectRepositoryHeads.commitSha, input.beforeCommitSha.toLowerCase())] : [])
    )).returning({ repository: projectRepositoryHeads.repository }));
  }

  async withGitIngestionLock<T>(ctx: AuthContext, input: { projectId: string; repository: string; branch: string }, run: () => Promise<T>): Promise<T> {
    const lockKey = `${ctx.tenantId}:${input.projectId}:${input.repository.toLowerCase()}:${input.branch}`;
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return run();
    });
  }

  async getGitIngestionHead(ctx: AuthContext, input: { projectId: string; repository: string; branch: string }) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx.select().from(gitIngestionHeads).where(and(
        eq(gitIngestionHeads.tenantId, ctx.tenantId),
        eq(gitIngestionHeads.projectId, input.projectId),
        eq(gitIngestionHeads.repository, input.repository.toLowerCase()),
        eq(gitIngestionHeads.branch, input.branch)
      )).limit(1);
      return rows[0];
    });
  }

  async advanceGitIngestionHead(ctx: AuthContext, input: {
    projectId: string; repository: string; branch: string; commitSha: string; accessPolicyId: string;
    expectedPreviousCommitSha?: string;
  }): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/i.test(input.commitSha)) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Git ingestion head must be an immutable 40-64 character SHA.", 400);
    }
    const set = {
      commitSha: input.commitSha.toLowerCase(),
      accessPolicyId: input.accessPolicyId,
      updatedAt: new Date()
    };
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx.insert(gitIngestionHeads).values({
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        repository: input.repository.toLowerCase(),
        branch: input.branch,
        ...set
      }).onConflictDoUpdate({
        target: [gitIngestionHeads.tenantId, gitIngestionHeads.projectId, gitIngestionHeads.repository, gitIngestionHeads.branch],
        set,
        where: input.expectedPreviousCommitSha
          ? eq(gitIngestionHeads.commitSha, input.expectedPreviousCommitSha.toLowerCase())
          : sql`false`
      }).returning({ commitSha: gitIngestionHeads.commitSha });
      return rows.length > 0;
    });
  }

  async listLatestTestExecutionResults(
    ctx: AuthContext,
    projectId: string,
    testItemIds: string[],
    mainHeadByRepository?: ReadonlyMap<string, string>
  ) {
    if (testItemIds.length === 0) return [];
    if (mainHeadByRepository && mainHeadByRepository.size === 0) return [];
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx.select().from(testExecutionResults).where(and(
        eq(testExecutionResults.tenantId, ctx.tenantId), eq(testExecutionResults.projectId, projectId),
        inArray(testExecutionResults.testItemId, testItemIds),
        ...(mainHeadByRepository ? [or(...[...mainHeadByRepository.entries()].map(([repository, commitSha]) => and(
          eq(testExecutionResults.repository, repository.toLowerCase()),
          eq(testExecutionResults.commitSha, commitSha.toLowerCase())
        )))] : [])
      )).orderBy(desc(testExecutionResults.executedAt), desc(testExecutionResults.createdAt));
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) if (!latest.has(row.testItemId)) latest.set(row.testItemId, row);
      return [...latest.values()];
    });
  }

  async createRunnerQuestion(
    ctx: AuthContext,
    input: { questionId: string; projectId: string; taskId: string; question: string; accessPolicyId: string }
  ) {
    if (input.question.trim().length === 0) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A pergunta não pode estar vazia.", 400);
    }
    return withTenantRls(this.db, ctx, async (tx) => {
      const task = await tx
        .select({ status: runnerTasks.status })
        .from(runnerTasks)
        .where(and(
          eq(runnerTasks.tenantId, ctx.tenantId),
          eq(runnerTasks.projectId, input.projectId),
          eq(runnerTasks.taskId, input.taskId)
        ))
        .limit(1);
      if (!task[0]) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${input.taskId}' não encontrada.`, 404);
      if (["completed", "failed", "escalated"].includes(task[0].status)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${input.taskId}' já terminou.`, 409);
      }
      const inserted = await tx
        .insert(runnerTaskQuestions)
        .values({
          questionId: input.questionId,
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          taskId: input.taskId,
          accessPolicyId: input.accessPolicyId,
          question: input.question.trim(),
          status: "pending"
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${input.taskId}' já tem uma pergunta pendente.`, 409);
      }
      await tx
        .update(runnerTasks)
        .set({ status: "awaiting_human" })
        .where(and(
          eq(runnerTasks.tenantId, ctx.tenantId),
          eq(runnerTasks.projectId, input.projectId),
          eq(runnerTasks.taskId, input.taskId)
        ));
      return inserted[0]!;
    });
  }

  async answerRunnerQuestion(
    ctx: AuthContext,
    input: {
      projectId: string;
      taskId: string;
      questionId: string;
      response: string;
      idempotencyKey: string;
    }
  ): Promise<{ questionId: string; status: "queued"; responseRecorded: true; duplicate: boolean }> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(runnerTaskQuestions)
        .where(and(
          eq(runnerTaskQuestions.tenantId, ctx.tenantId),
          eq(runnerTaskQuestions.projectId, input.projectId),
          eq(runnerTaskQuestions.taskId, input.taskId),
          eq(runnerTaskQuestions.questionId, input.questionId)
        ))
        .limit(1);
      const question = rows[0];
      if (!question) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${input.questionId}' não encontrada para a tarefa.`, 404);
      const response = input.response.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      if (!response || !idempotencyKey) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resposta e idempotencyKey não podem estar vazias.", 400);
      }
      if (question.status === "answered") {
        if (question.responseIdempotencyKey === idempotencyKey && question.response === response) {
          return { questionId: input.questionId, status: "queued", responseRecorded: true, duplicate: true };
        }
        throw new BrainError("BRAIN_ERR_CONFLICT", `Pergunta '${input.questionId}' já foi respondida.`, 409);
      }
      const answered = await tx
        .update(runnerTaskQuestions)
        .set({
          status: "answered",
          response,
          responseIdempotencyKey: idempotencyKey,
          answeredBy: ctx.actorId,
          answeredAt: new Date()
        })
        .where(and(
          eq(runnerTaskQuestions.tenantId, ctx.tenantId),
          eq(runnerTaskQuestions.projectId, input.projectId),
          eq(runnerTaskQuestions.taskId, input.taskId),
          eq(runnerTaskQuestions.questionId, input.questionId),
          eq(runnerTaskQuestions.status, "pending")
        ))
        .returning({ questionId: runnerTaskQuestions.questionId });
      if (answered.length === 0) throw new BrainError("BRAIN_ERR_CONFLICT", `Pergunta '${input.questionId}' já foi respondida.`, 409);
      await tx
        .update(runnerTasks)
        .set({ status: "queued" })
        .where(and(
          eq(runnerTasks.tenantId, ctx.tenantId),
          eq(runnerTasks.projectId, input.projectId),
          eq(runnerTasks.taskId, input.taskId),
          eq(runnerTasks.status, "awaiting_human")
        ));
      return { questionId: input.questionId, status: "queued", responseRecorded: true, duplicate: false };
    });
  }

  async listRunnerTaskQuestions(ctx: AuthContext, projectId: string, taskId: string) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select()
        .from(runnerTaskQuestions)
        .where(and(
          eq(runnerTaskQuestions.tenantId, ctx.tenantId),
          eq(runnerTaskQuestions.projectId, projectId),
          eq(runnerTaskQuestions.taskId, taskId)
        ))
        .orderBy(runnerTaskQuestions.createdAt)
    );
  }

  async listPendingRunnerQuestions(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select({
          questionId: runnerTaskQuestions.questionId,
          taskId: runnerTaskQuestions.taskId,
          projectId: runnerTaskQuestions.projectId,
          question: runnerTaskQuestions.question,
          createdAt: runnerTaskQuestions.createdAt
        })
        .from(runnerTaskQuestions)
        .where(and(
          eq(runnerTaskQuestions.tenantId, ctx.tenantId),
          eq(runnerTaskQuestions.projectId, projectId),
          eq(runnerTaskQuestions.status, "pending")
        ))
        .orderBy(runnerTaskQuestions.createdAt)
    );
  }

  async claimIntegrationEvent(
    ctx: AuthContext,
    input: {
      provider: string;
      externalEventId: string;
      projectId: string;
      proposalId: string;
      accessPolicyId: string;
      eventHash: string;
    }
  ): Promise<{ state: "claimed" | "duplicate" | "in_progress" | "key_conflict"; response?: Record<string, unknown> }> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const values = {
        tenantId: ctx.tenantId,
        ...input,
        status: "processing"
      };
      const inserted = await tx
        .insert(integrationEvents)
        .values(values)
        .onConflictDoNothing()
        .returning({ externalEventId: integrationEvents.externalEventId });
      if (inserted.length > 0) return { state: "claimed" };

      const rows = await tx
        .select()
        .from(integrationEvents)
        .where(and(
          eq(integrationEvents.tenantId, ctx.tenantId),
          eq(integrationEvents.provider, input.provider),
          eq(integrationEvents.externalEventId, input.externalEventId)
        ))
        .limit(1);
      const existing = rows[0];
      if (!existing || existing.eventHash !== input.eventHash) return { state: "key_conflict" };
      if (existing.status === "completed") {
        return {
          state: "duplicate",
          response: existing.response as Record<string, unknown> | undefined
        };
      }
      const reclaimed = await tx
        .update(integrationEvents)
        .set({ updatedAt: new Date() })
        .where(and(
          eq(integrationEvents.tenantId, ctx.tenantId),
          eq(integrationEvents.provider, input.provider),
          eq(integrationEvents.externalEventId, input.externalEventId),
          eq(integrationEvents.eventHash, input.eventHash),
          eq(integrationEvents.status, "processing"),
          lt(integrationEvents.updatedAt, new Date(Date.now() - 5 * 60_000))
        ))
        .returning({ externalEventId: integrationEvents.externalEventId });
      if (reclaimed.length > 0) return { state: "claimed" };
      return { state: "in_progress" };
    });
  }

  async completeIntegrationEvent(
    ctx: AuthContext,
    input: { provider: string; externalEventId: string; response: Record<string, unknown> }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .update(integrationEvents)
        .set({ status: "completed", response: input.response, updatedAt: new Date() })
        .where(and(
          eq(integrationEvents.tenantId, ctx.tenantId),
          eq(integrationEvents.provider, input.provider),
          eq(integrationEvents.externalEventId, input.externalEventId),
          eq(integrationEvents.status, "processing")
        ));
    });
  }

  async releaseIntegrationEvent(ctx: AuthContext, provider: string, externalEventId: string): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .delete(integrationEvents)
        .where(and(
          eq(integrationEvents.tenantId, ctx.tenantId),
          eq(integrationEvents.provider, provider),
          eq(integrationEvents.externalEventId, externalEventId),
          eq(integrationEvents.status, "processing")
        ));
    });
  }

  async saveHandoff(
    ctx: AuthContext,
    input: {
      handoffId: string;
      projectId: string;
      taskId: string;
      fromAgent: string;
      repoUrl: string;
      branch: string;
      baseCommitSha: string;
      workingTreeDirty: boolean;
      ephemeralBranch?: string;
      modifiedFiles: string[];
      testsExecuted: string[];
      decisions: string[];
      nextSteps: string[];
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(handoffs).values({
        handoffId: input.handoffId,
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        taskId: input.taskId,
        actorId: ctx.actorId,
        fromAgent: input.fromAgent,
        repoUrl: input.repoUrl,
        branch: input.branch,
        baseCommitSha: input.baseCommitSha,
        workingTreeDirty: input.workingTreeDirty,
        ephemeralBranch: input.ephemeralBranch ?? null,
        modifiedFiles: input.modifiedFiles,
        testsExecuted: input.testsExecuted,
        decisions: input.decisions,
        nextSteps: input.nextSteps
      });
    });
  }

  async getLatestHandoff(ctx: AuthContext, projectId: string, taskId?: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(handoffs)
        .where(
          taskId
            ? and(eq(handoffs.tenantId, ctx.tenantId), eq(handoffs.projectId, projectId), eq(handoffs.taskId, taskId))
            : and(eq(handoffs.tenantId, ctx.tenantId), eq(handoffs.projectId, projectId))
        )
        .orderBy(desc(handoffs.createdAt))
        .limit(1);
      return rows[0];
    });
  }

  async listHandoffs(ctx: AuthContext, projectId: string, limit = 20) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.tenantId, ctx.tenantId), eq(handoffs.projectId, projectId)))
        .orderBy(desc(handoffs.createdAt))
        .limit(limit)
    );
  }

  async getHandoffById(ctx: AuthContext, projectId: string, handoffId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(handoffs)
        .where(and(
          eq(handoffs.tenantId, ctx.tenantId),
          eq(handoffs.projectId, projectId),
          eq(handoffs.handoffId, handoffId)
        ))
        .limit(1);
      return rows[0];
    });
  }

  async getTaskLease(ctx: AuthContext, projectId: string, taskId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(taskLeases)
        .where(and(
          eq(taskLeases.tenantId, ctx.tenantId),
          eq(taskLeases.projectId, projectId),
          eq(taskLeases.taskId, taskId),
          gt(taskLeases.expiresAt, new Date())
        ))
        .limit(1);
      return rows[0];
    });
  }

  async upsertLease(
    ctx: AuthContext,
    projectId: string,
    taskId: string,
    branch: string,
    ttlMs = 30 * 60_000,
    targetFiles: string[] = []
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(taskLeases)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          taskId,
          actorId: ctx.actorId,
          branch,
          targetFiles,
          expiresAt
        })
        .onConflictDoUpdate({
          target: [taskLeases.tenantId, taskLeases.projectId, taskLeases.taskId],
          set: { actorId: ctx.actorId, branch, targetFiles, expiresAt }
        });
    });
  }

  async findOverlappingFileLeases(
    ctx: AuthContext,
    projectId: string,
    excludeTaskId: string,
    targetFiles: string[]
  ): Promise<Array<{ taskId: string; actorId: string; branch: string; overlappingFiles: string[] }>> {
    if (targetFiles.length === 0) return [];
    const targetSet = new Set(targetFiles);
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(taskLeases)
        .where(and(
          eq(taskLeases.tenantId, ctx.tenantId),
          eq(taskLeases.projectId, projectId),
          gt(taskLeases.expiresAt, new Date())
        ));
      return rows
        .filter((row) => row.taskId !== excludeTaskId && row.actorId !== ctx.actorId)
        .map((row) => ({
          taskId: row.taskId,
          actorId: row.actorId,
          branch: row.branch,
          overlappingFiles: (row.targetFiles ?? []).filter((f) => targetSet.has(f))
        }))
        .filter((entry) => entry.overlappingFiles.length > 0);
    });
  }

  async saveRunnerTask(
    ctx: AuthContext,
    task: {
      taskId: string;
      projectId: string;
      instruction: string;
      priority: string;
      status: string;
      resultSummary?: string;
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(runnerTasks)
        .values({
          taskId: task.taskId,
          tenantId: ctx.tenantId,
          projectId: task.projectId,
          actorId: ctx.actorId,
          instruction: task.instruction,
          priority: task.priority,
          draftOnly: true,
          status: task.status,
          resultSummary: task.resultSummary ?? null
        })
        .onConflictDoUpdate({
          target: [runnerTasks.taskId],
          set: { status: task.status, resultSummary: task.resultSummary ?? null }
        });
    });
  }

  async saveScheduledRunnerTask(
    ctx: AuthContext,
    task: { taskId: string; projectId: string; instruction: string; priority: string }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(runnerTasks)
        .values({
          taskId: task.taskId,
          tenantId: ctx.tenantId,
          projectId: task.projectId,
          actorId: ctx.actorId,
          instruction: task.instruction,
          priority: task.priority,
          draftOnly: true,
          status: "queued"
        })
        .onConflictDoNothing({ target: [runnerTasks.taskId] });
    });
  }

  async claimNextRunnerTask(tenantId?: string): Promise<{
    taskId: string;
    tenantId: string;
    projectId: string;
    instruction: string;
    priority: string;
  } | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<{
        task_id: string;
        tenant_id: string;
        project_id: string;
        instruction: string;
        priority: string;
      }>(
        tenantId
          ? sql`
            SELECT task_id, tenant_id, project_id, instruction, priority
            FROM runner_tasks
            WHERE status = 'queued' AND tenant_id = ${tenantId}
            ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `
          : sql`
            SELECT task_id, tenant_id, project_id, instruction, priority
            FROM runner_tasks
            WHERE status = 'queued'
            ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `
      );
      const row = rows[0];
      if (!row) return null;
      const clarifications = await tx.execute<{ question: string; response: string }>(sql`
        SELECT question, response
        FROM runner_task_questions
        WHERE tenant_id = ${row.tenant_id}
          AND project_id = ${row.project_id}
          AND task_id = ${row.task_id}
          AND status = 'answered'
        ORDER BY answered_at DESC
        LIMIT 1
      `);
      await tx
        .update(runnerTasks)
        .set({ status: "running" })
        .where(eq(runnerTasks.taskId, row.task_id));
      return {
        taskId: row.task_id,
        tenantId: row.tenant_id,
        projectId: row.project_id,
        instruction: clarifications[0]
          ? `${row.instruction}\n\nHuman clarification:\nQuestion: ${clarifications[0].question}\nAnswer: ${clarifications[0].response}`
          : row.instruction,
        priority: row.priority
      };
    });
  }

  async completeRunnerTask(
    taskId: string,
    status: "completed" | "failed" | "escalated",
    resultSummary?: string,
    resultMetadata?: Record<string, unknown>
  ): Promise<void> {
    await this.db
      .update(runnerTasks)
      .set({
        status,
        ...(resultSummary !== undefined ? { resultSummary } : {}),
        ...(resultMetadata !== undefined ? { resultMetadata } : {})
      })
      .where(and(eq(runnerTasks.taskId, taskId), eq(runnerTasks.status, "running")));
  }

  async listRunnerTasks(ctx: AuthContext, projectId: string, limit = 50) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select()
        .from(runnerTasks)
        .where(and(eq(runnerTasks.tenantId, ctx.tenantId), eq(runnerTasks.projectId, projectId)))
        .orderBy(desc(runnerTasks.createdAt))
        .limit(limit)
    );
  }

  async cancelRunnerTask(ctx: AuthContext, projectId: string, taskId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .update(runnerTasks)
        .set({ status: "cancelled", resultSummary: "Cancelada pelo operador." })
        .where(
          and(
            eq(runnerTasks.tenantId, ctx.tenantId),
            eq(runnerTasks.projectId, projectId),
            eq(runnerTasks.taskId, taskId),
            inArray(runnerTasks.status, ["queued", "waiting_human", "escalated"])
          )
        )
        .returning();
      return rows[0] ?? null;
    });
  }

  async appendSyncChange(
    ctx: AuthContext,
    input: { projectId: string; itemId: string; contentHash: string; accessPolicyId: string; deletedAt?: Date }
  ): Promise<number> {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(syncProjectLocks).values({
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        lockedAt: new Date()
      }).onConflictDoUpdate({
        target: [syncProjectLocks.tenantId, syncProjectLocks.projectId],
        set: { lockedAt: new Date() }
      });
      const inserted = await tx
        .insert(syncChanges)
        .values({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          itemId: input.itemId,
          contentHash: input.contentHash,
          accessPolicyId: input.accessPolicyId,
          deletedAt: input.deletedAt ?? null
        })
        .returning({ syncSeq: syncChanges.syncSeq });
      return inserted[0]?.syncSeq ?? 0;
    });
  }

  async pullSyncChanges(ctx: AuthContext, projectId: string, sinceSeq = 0, limit = 100) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select()
        .from(syncChanges)
        .where(and(eq(syncChanges.tenantId, ctx.tenantId), eq(syncChanges.projectId, projectId), gt(syncChanges.syncSeq, sinceSeq)))
        .orderBy(asc(syncChanges.syncSeq))
        .limit(limit)
    );
  }

  async getLatestSyncSeq(ctx: AuthContext, projectId: string): Promise<number> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const result = await tx.execute(sql`
        SELECT COALESCE(MAX(sync_seq), 0)::int AS sync_seq
        FROM public.sync_changes
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}
      `);
      return Number(result[0]?.sync_seq ?? 0);
    });
  }

  async appendMemory(
    ctx: AuthContext,
    input: { projectId: string; layer: MemoryLayer; sessionId?: string; content: string; accessPolicyId: string }
  ): Promise<void> {
    const expiresAt =
      input.layer === "working"
        ? new Date(Date.now() + 24 * 60 * 60_000)
        : input.layer === "episodic"
          ? new Date(Date.now() + 60 * 24 * 60 * 60_000)
          : null;
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(memoryEntries).values({
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        actorId: ctx.actorId,
        layer: input.layer,
        sessionId: input.sessionId ?? null,
        content: input.content,
        accessPolicyId: input.accessPolicyId,
        expiresAt
      });
    });
  }

  /**
   * Memory Decay (Itens 9 e 23): compacta Episodic expirados para Semantic, opcionalmente arquiva no cold storage e decai arestas is_inferred > 60 dias.
   */
  async runMemoryDecay(
    ctx: AuthContext,
    options?: { coldArchive?: (entries: Array<{ id: string; projectId: string; actorId: string | null; layer: string; content: string; createdAt: Date }>) => Promise<void> }
  ): Promise<{ expiredMemoryRemoved: number; compactedSemanticCreated: number; decayedRelationsRemoved: number; retainedByAccessCount: number }> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60_000);

      // Compact expired episodic memories into semantic summaries before deletion
      const expiredRows = await tx
        .select()
        .from(memoryEntries)
        .where(and(
          eq(memoryEntries.tenantId, ctx.tenantId),
          inArray(memoryEntries.projectId, ctx.allowedProjects),
          inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
          sql`${memoryEntries.expiresAt} IS NOT NULL AND (${memoryEntries.expiresAt} + make_interval(days => LEAST(90, GREATEST(0, ${memoryEntries.hitCount}) * 7))) < ${nowIso}`
        ));

      let compactedSemanticCreated = 0;
      const episodicByGroup = new Map<string, typeof expiredRows>();
      for (const row of expiredRows) {
        if (row.layer !== "episodic") continue;
        const groupKey = `${row.projectId}\u0000${row.accessPolicyId}`;
        const list = episodicByGroup.get(groupKey) ?? [];
        list.push(row);
        episodicByGroup.set(groupKey, list);
      }
      for (const [groupKey, rows] of episodicByGroup.entries()) {
        const [projectId, accessPolicyId] = groupKey.split("\u0000");
        const summary = `Resumo consolidado de ${rows.length} memórias episódicas: ${rows.map((r) => r.content).join(" | ").slice(0, 4000)}`;
        await tx.insert(memoryEntries).values({
          tenantId: ctx.tenantId,
          projectId: projectId!,
          actorId: ctx.actorId,
          layer: "semantic",
          sessionId: null,
          content: summary,
          accessPolicyId: accessPolicyId!,
          expiresAt: null
        });
        compactedSemanticCreated += 1;
      }

      if (expiredRows.length > 0 && options?.coldArchive) {
        await options.coldArchive(
          expiredRows.map((r) => ({
            id: r.id,
            projectId: r.projectId,
            actorId: r.actorId,
            layer: r.layer,
            content: r.content,
            createdAt: r.createdAt
          }))
        );
      }

      // Access-weighted retention: memories with hit_count > 0 receive a grace extension
      // of 7 days per hit (capped at 90 days) before expiration.
      const expired = expiredRows.length === 0
        ? []
        : await tx
            .delete(memoryEntries)
            .where(and(
              eq(memoryEntries.tenantId, ctx.tenantId),
              inArray(memoryEntries.projectId, ctx.allowedProjects),
              inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
              sql`${memoryEntries.expiresAt} IS NOT NULL AND (${memoryEntries.expiresAt} + make_interval(days => LEAST(90, GREATEST(0, ${memoryEntries.hitCount}) * 7))) < ${nowIso}`
            ))
            .returning({ id: memoryEntries.id });

      const retainedRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(memoryEntries)
        .where(and(
          eq(memoryEntries.tenantId, ctx.tenantId),
          inArray(memoryEntries.projectId, ctx.allowedProjects),
          inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
          lt(memoryEntries.expiresAt, now),
          gt(memoryEntries.hitCount, 0)
        ));

      // Inferred relations whose connected knowledge items have Context Hit Rate hits
      // decay slower (up to +90 days grace) than zero-hit relations.
      const decayed = await tx
        .delete(knowledgeRelations)
        .where(
          and(
            eq(knowledgeRelations.tenantId, ctx.tenantId),
            inArray(knowledgeRelations.fromProjectId, ctx.allowedProjects),
            inArray(knowledgeRelations.toProjectId, ctx.allowedProjects),
            inArray(knowledgeRelations.fromPolicyId, ctx.allowedPolicies),
            inArray(knowledgeRelations.toPolicyId, ctx.allowedPolicies),
            eq(knowledgeRelations.isInferred, true),
            lt(knowledgeRelations.createdAt, sixtyDaysAgo),
            sql`NOT EXISTS (
              SELECT 1 FROM knowledge_items ki
              WHERE ki.tenant_id = ${knowledgeRelations.tenantId}
                AND ((ki.project_id = ${knowledgeRelations.fromProjectId} AND ki.id = ${knowledgeRelations.fromItemId})
                  OR (ki.project_id = ${knowledgeRelations.toProjectId} AND ki.id = ${knowledgeRelations.toItemId}))
                AND ki.context_hit_count > 0
                AND (${knowledgeRelations.createdAt} + interval '60 days' + make_interval(days => LEAST(90, ki.context_hit_count * 7))) >= ${nowIso}
            )`
          )
        )
        .returning({ id: knowledgeRelations.id });

      return {
        expiredMemoryRemoved: expired.length,
        compactedSemanticCreated,
        decayedRelationsRemoved: decayed.length,
        retainedByAccessCount: Number(retainedRows[0]?.count ?? 0)
      };
    });
  }

  async getDeveloperProfile(ctx: AuthContext) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(developerProfiles)
        .where(and(eq(developerProfiles.tenantId, ctx.tenantId), eq(developerProfiles.actorId, ctx.actorId)))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        tenantId: row.tenantId,
        actorId: row.actorId,
        preferredPackageManager: row.preferredPackageManager ?? undefined,
        preferredTestLayout: row.preferredTestLayout ?? undefined,
        preferredArchitectureStyle: row.preferredArchitectureStyle ?? undefined,
        codingConventions: row.codingConventions ?? [],
        preferredHarness: row.preferredHarness ?? undefined,
        optInCrossProject: row.optInCrossProject,
        updatedAt: row.updatedAt.toISOString()
      };
    });
  }

  async upsertDeveloperProfile(
    ctx: AuthContext,
    input: {
      preferredPackageManager?: string;
      preferredTestLayout?: string;
      preferredArchitectureStyle?: string;
      codingConventions?: string[];
      preferredHarness?: string;
      optInCrossProject?: boolean;
    }
  ) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(developerProfiles)
        .values({
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          preferredPackageManager: input.preferredPackageManager ?? null,
          preferredTestLayout: input.preferredTestLayout ?? null,
          preferredArchitectureStyle: input.preferredArchitectureStyle ?? null,
          codingConventions: input.codingConventions ?? [],
          preferredHarness: input.preferredHarness ?? null,
          optInCrossProject: input.optInCrossProject ?? true,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [developerProfiles.tenantId, developerProfiles.actorId],
          set: {
            preferredPackageManager: input.preferredPackageManager ?? null,
            preferredTestLayout: input.preferredTestLayout ?? null,
            preferredArchitectureStyle: input.preferredArchitectureStyle ?? null,
            codingConventions: input.codingConventions ?? [],
            preferredHarness: input.preferredHarness ?? null,
            optInCrossProject: input.optInCrossProject ?? true,
            updatedAt: now
          }
        })
        .returning();
      return {
        tenantId: row!.tenantId,
        actorId: row!.actorId,
        preferredPackageManager: row!.preferredPackageManager ?? undefined,
        preferredTestLayout: row!.preferredTestLayout ?? undefined,
        preferredArchitectureStyle: row!.preferredArchitectureStyle ?? undefined,
        codingConventions: row!.codingConventions ?? [],
        preferredHarness: row!.preferredHarness ?? undefined,
        optInCrossProject: row!.optInCrossProject,
        updatedAt: row!.updatedAt.toISOString()
      };
    });
  }

  async deleteDeveloperProfile(ctx: AuthContext): Promise<boolean> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx
        .delete(developerProfiles)
        .where(and(eq(developerProfiles.tenantId, ctx.tenantId), eq(developerProfiles.actorId, ctx.actorId)))
        .returning({ id: developerProfiles.id });
      return deleted.length > 0;
    });
  }

  async saveCrossServiceContract(
    ctx: AuthContext,
    edge: {
      fromProjectId: string;
      fromService: string;
      relation: string;
      toProjectId: string;
      contractId: string;
      schemaVersion: string;
      accessPolicyId: string;
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(crossServiceContracts).values({
        tenantId: ctx.tenantId,
        ...edge
      });
    });
  }

  async listDepartmentFinopsQuotas(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(departmentFinopsQuotas)
        .where(and(eq(departmentFinopsQuotas.tenantId, ctx.tenantId), eq(departmentFinopsQuotas.projectId, projectId)))
        .orderBy(asc(departmentFinopsQuotas.department));
      return rows.map((row) => ({
        department: row.department,
        monthlyTokenLimit: row.monthlyTokenLimit,
        monthlyUsdLimit: Number(row.monthlyUsdLimit),
        downgradeModel: row.downgradeModel ?? undefined,
        updatedAt: row.updatedAt.toISOString()
      }));
    });
  }

  async upsertDepartmentFinopsQuota(
    ctx: AuthContext,
    projectId: string,
    input: { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; downgradeModel?: string }
  ) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(departmentFinopsQuotas)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          department: input.department,
          monthlyTokenLimit: input.monthlyTokenLimit,
          monthlyUsdLimit: String(input.monthlyUsdLimit),
          downgradeModel: input.downgradeModel ?? null,
          accessPolicyId: "internal-project",
          updatedBy: ctx.actorId,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [departmentFinopsQuotas.tenantId, departmentFinopsQuotas.projectId, departmentFinopsQuotas.department],
          set: {
            monthlyTokenLimit: input.monthlyTokenLimit,
            monthlyUsdLimit: String(input.monthlyUsdLimit),
            downgradeModel: input.downgradeModel ?? null,
            updatedBy: ctx.actorId,
            updatedAt: now
          }
        })
        .returning();
      return {
        department: row!.department,
        monthlyTokenLimit: row!.monthlyTokenLimit,
        monthlyUsdLimit: Number(row!.monthlyUsdLimit),
        downgradeModel: row!.downgradeModel ?? undefined,
        updatedAt: row!.updatedAt.toISOString()
      };
    });
  }

  async upsertIntegrationFallbackOwner(ctx: AuthContext, projectId: string, provider: string, fallbackOwner: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(integrationFallbackOwners)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          provider,
          fallbackOwner,
          accessPolicyId: "internal-project",
          updatedBy: ctx.actorId,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [integrationFallbackOwners.tenantId, integrationFallbackOwners.projectId, integrationFallbackOwners.provider],
          set: {
            fallbackOwner,
            updatedBy: ctx.actorId,
            updatedAt: now
          }
        })
        .returning();
      return {
        provider: row!.provider,
        fallbackOwner: row!.fallbackOwner,
        updatedBy: row!.updatedBy,
        updatedAt: row!.updatedAt.toISOString()
      };
    });
  }

  async listIntegrationFallbackOwners(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(integrationFallbackOwners)
        .where(and(eq(integrationFallbackOwners.tenantId, ctx.tenantId), eq(integrationFallbackOwners.projectId, projectId)));
      return rows.map((row) => ({
        provider: row.provider,
        fallbackOwner: row.fallbackOwner,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString()
      }));
    });
  }

  async recordIntegrationReconnect(ctx: AuthContext, projectId: string, provider: string, status: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx
        .insert(integrationReconnectHistory)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          provider,
          status,
          actorId: ctx.actorId,
          accessPolicyId: "internal-project"
        })
        .returning();
      return {
        provider: row!.provider,
        status: row!.status,
        actorId: row!.actorId,
        lastReconnectAt: row!.lastReconnectAt.toISOString()
      };
    });
  }

  async listIntegrationReconnectHistory(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(integrationReconnectHistory)
        .where(and(eq(integrationReconnectHistory.tenantId, ctx.tenantId), eq(integrationReconnectHistory.projectId, projectId)))
        .orderBy(desc(integrationReconnectHistory.lastReconnectAt))
        .limit(50);
      return rows.map((row) => ({
        provider: row.provider,
        status: row.status,
        actorId: row.actorId,
        lastReconnectAt: row.lastReconnectAt.toISOString()
      }));
    });
  }

  async recordLgpdShreddedSubject(ctx: AuthContext, projectId: string, subjectId: string): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(lgpdShreddedSubjects)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          subjectId,
          accessPolicyId: "internal-project",
          shreddedBy: ctx.actorId
        })
        .onConflictDoUpdate({
          target: [lgpdShreddedSubjects.tenantId, lgpdShreddedSubjects.projectId, lgpdShreddedSubjects.subjectId],
          set: { shreddedBy: ctx.actorId, shreddedAt: new Date() }
        });
    });
  }

  async isLgpdSubjectShredded(ctx: AuthContext, projectId: string, subjectId: string): Promise<boolean> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select({ subjectId: lgpdShreddedSubjects.subjectId })
        .from(lgpdShreddedSubjects)
        .where(and(
          eq(lgpdShreddedSubjects.tenantId, ctx.tenantId),
          eq(lgpdShreddedSubjects.projectId, projectId),
          eq(lgpdShreddedSubjects.subjectId, subjectId)
        ))
        .limit(1);
      return rows.length > 0;
    });
  }
}

export const HNSW_UPGRADE_INDEX_SQL = sql.raw(
  `CREATE INDEX IF NOT EXISTS idx_ke_embedding_hnsw ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);`
);

