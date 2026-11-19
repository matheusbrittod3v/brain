import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AuthContext } from "@brain/auth";
import {
  BrainError,
  validateContextSessionId,
  type ContextSessionEvidence,
  type ContextSessionHitRate,
  type ContextSessionItemInput
} from "@brain/core";
import { withTenantRls } from "../client.js";
import {
  approvalReminderEvents,
  approvalRequests,
  auditLogs,
  contextSessionItems,
  gitIngestionHeads,
  knowledgeItems,
  policyEpochStates,
  projectRepositoryHeads,
  taskLeases,
  testExecutionResults
} from "../schema.js";
import { PgAccessRbacRepo } from "./access-rbac.js";
import { getContextHitRateInTransaction, recordContextEvidenceInTransaction } from "./shared.js";

export class PgContextGitRepo extends PgAccessRbacRepo {
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
}

