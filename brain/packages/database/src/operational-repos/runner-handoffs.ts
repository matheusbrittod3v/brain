import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import { withTenantRls } from "../client.js";
import {
  handoffs,
  integrationEvents,
  runnerTaskQuestions,
  runnerTasks,
  taskLeases
} from "../schema.js";
import { PgContextGitRepo } from "./context-git.js";

export class PgRunnerHandoffsRepo extends PgContextGitRepo {
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

  async releaseLease(ctx: AuthContext, projectId: string, taskId: string): Promise<boolean> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx
        .delete(taskLeases)
        .where(and(
          eq(taskLeases.tenantId, ctx.tenantId),
          eq(taskLeases.projectId, projectId),
          eq(taskLeases.taskId, taskId)
        ))
        .returning({ taskId: taskLeases.taskId });
      return deleted.length > 0;
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
}

