import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { BrainError } from "@brain/core";
import { resolveActiveFinopsDowngrade } from "../../services/finops-quota.js";
import { cancelRunnerSchedule, listRunnerSchedules } from "@brain/mcp-server";
import { MAX_ARTIFACT_BYTES, uploadObjectToMinio, validateSafeArtifactName } from "../../services/minio-storage.js";
import type { RunnerRouteDeps, RunnerSharedState } from "./security.js";

export function registerRunnerTaskRoutes(
  app: FastifyInstance,
  deps: RunnerRouteDeps,
  state: RunnerSharedState
) {
  const { authenticateProjectRequest, enforcePolicy, recordAudit, runner, opRepo, projectModelUsage } = deps;

  app.post<{ Params: { projectId: string }; Body: { instruction: string; priority?: "low" | "normal" | "high" } }>(
    "/v1/projects/:projectId/runner/tasks",
    { schema: { body: Type.Object({ instruction: Type.String(), priority: Type.Optional(Type.String()) }) } },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      state.enforceRunnerRateLimit(ctx.actorId, req.params.projectId);
      const currentTasks = opRepo
        ? await opRepo.listRunnerTasks(ctx, req.params.projectId)
        : runner.listTasks(ctx, req.params.projectId);
      const activeCount = currentTasks.filter((t) => t.status === "queued" || t.status === "running").length;
      if (activeCount >= state.maxActiveTasks) {
        throw new BrainError(
          "BRAIN_ERR_CONFLICT",
          `Limite de ${state.maxActiveTasks} tarefas simultâneas na fila atingido para este projeto.`,
          429
        );
      }
      const finopsDowngrade = await resolveActiveFinopsDowngrade({
        ctx,
        projectId: req.params.projectId,
        opRepo,
        projectModelUsage
      });
      const task = runner.enqueue(ctx, { projectId: req.params.projectId, instruction: req.body.instruction, priority: req.body.priority });
      if (opRepo) await opRepo.saveRunnerTask(ctx, task);
      const taskPayload = finopsDowngrade.downgraded
        ? {
            ...task,
            finopsDowngraded: true,
            effectiveProvider: finopsDowngrade.provider,
            effectiveModel: finopsDowngrade.model,
            downgradeReason: finopsDowngrade.reason
          }
        : { ...task, finopsDowngraded: false };
      void uploadObjectToMinio({
        key: `${ctx.tenantId}/${req.params.projectId}/runner-tasks/${task.taskId}/task-spec.json`,
        body: JSON.stringify(taskPayload, null, 2),
        contentType: "application/json"
      });
      return taskPayload;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/schedules", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
    const schedules = await listRunnerSchedules({ tenantId: ctx.tenantId, projectId: req.params.projectId }, databaseUrl);
    return { schedules };
  });

  app.delete<{ Params: { projectId: string; scheduleId: string } }>(
    "/v1/projects/:projectId/runner/schedules/:scheduleId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!databaseUrl) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Cron do Runner requer PostgreSQL/pg-boss.", 503);
      const cancelled = await cancelRunnerSchedule({ tenantId: ctx.tenantId, projectId: req.params.projectId }, req.params.scheduleId, databaseUrl);
      if (!cancelled) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Schedule '${req.params.scheduleId}' não encontrado.`, 404);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "revoke",
        targetType: "runner_schedule",
        targetId: req.params.scheduleId,
        metadata: {}
      });
      return { scheduleId: req.params.scheduleId, cancelled: true };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/runner/tasks", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const tasks = opRepo ? await opRepo.listRunnerTasks(ctx, req.params.projectId) : runner.listTasks(ctx, req.params.projectId);
    const pendingQuestions = opRepo
      ? await opRepo.listPendingRunnerQuestions(ctx, req.params.projectId)
      : runner.listPendingQuestions(ctx, req.params.projectId);
    const questionByTask = new Map(pendingQuestions.map((question) => [question.taskId, question]));
    return {
      tasks: tasks.map((task) => {
        const pendingQuestion = questionByTask.get(task.taskId);
        return pendingQuestion
          ? { ...task, pendingQuestion: { questionId: pendingQuestion.questionId, question: pendingQuestion.question } }
          : task;
      })
    };
  });

  app.post<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/cancel",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (opRepo) {
        const cancelled = await opRepo.cancelRunnerTask(ctx, req.params.projectId, req.params.taskId);
        if (!cancelled) {
          throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`, 409);
        }
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "revoke",
          targetType: "runner_task",
          targetId: req.params.taskId,
          metadata: { status: "cancelled" }
        });
        return cancelled;
      }
      const task = runner.getTask(ctx, req.params.taskId);
      if (!task || task.projectId !== req.params.projectId || !["queued", "waiting_human", "escalated"].includes(task.status)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${req.params.taskId}' não encontrada ou não pode ser cancelada no estado atual.`, 409);
      }
      task.status = "cancelled" as typeof task.status;
      task.resultSummary = "Cancelada pelo operador.";
      return task;
    }
  );

  app.post<{ Params: { projectId: string; taskId: string }; Body: { question: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/questions",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
        body: Type.Object({ question: Type.String({ minLength: 1 }) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const questionText = req.body.question.trim();
      if (!questionText) throw new BrainError("BRAIN_ERR_CONFLICT", "A pergunta não pode estar vazia.", 400);
      const question = opRepo
        ? await opRepo.createRunnerQuestion(ctx, {
            questionId: randomUUID(),
            projectId: req.params.projectId,
            taskId: req.params.taskId,
            question: questionText,
            accessPolicyId: "internal-project"
          })
        : runner.askQuestion(ctx, req.params.taskId, questionText);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task_question",
        targetId: question.questionId,
        metadata: { taskId: req.params.taskId }
      });
      return { questionId: question.questionId, taskId: req.params.taskId, question: question.question, status: question.status };
    }
  );

  app.get<{ Params: { projectId: string; taskId: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/questions",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const questions = opRepo
        ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
        : runner.listQuestions(ctx, req.params.taskId);
      return { questions };
    }
  );

  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { fileName: string; content: string; isBase64?: boolean; contentType?: string };
  }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/artifacts",
    {
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
        body: Type.Object({
          fileName: Type.String({ minLength: 1, maxLength: 180 }),
          content: Type.String({ minLength: 1 }),
          isBase64: Type.Optional(Type.Boolean()),
          contentType: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (!/^[A-Za-z0-9_-]{3,80}$/.test(req.params.taskId)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "taskId inválido.", 422);
      }
      const projectTasks = opRepo
        ? await opRepo.listRunnerTasks(ctx, req.params.projectId)
        : runner.listTasks(ctx, req.params.projectId);
      const taskRecord = projectTasks.find((t) => t.taskId === req.params.taskId);
      if (!taskRecord) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${req.params.taskId}' não pertence ao projeto '${req.params.projectId}'.`, 404);
      }

      const { safeName } = validateSafeArtifactName(req.body.fileName);
      const bodyBuf = req.body.isBase64 ? Buffer.from(req.body.content, "base64") : Buffer.from(req.body.content, "utf8");
      if (bodyBuf.length === 0 || bodyBuf.length > MAX_ARTIFACT_BYTES) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Artefato vazio ou acima do limite máximo de 8 MiB.", 422);
      }
      const uploaded = await uploadObjectToMinio({
        key: `${ctx.tenantId}/${req.params.projectId}/runner-artifacts/${req.params.taskId}/${safeName}`,
        body: bodyBuf,
        contentType: req.body.contentType ?? "application/octet-stream",
        presignExpiresSeconds: 900
      });
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task_artifact",
        targetId: `${req.params.taskId}/${safeName}`,
        metadata: {
          uri: uploaded.uri,
          sizeBytes: bodyBuf.length,
          expiresInSeconds: uploaded.expiresInSeconds,
          uploaded: uploaded.uploaded
        }
      }).catch(() => undefined);
      return uploaded;
    }
  );

  app.post<{
    Params: { projectId: string; taskId: string };
    Body: { instructionOverride?: string; linkedRuleIds?: string[]; linkedDocIds?: string[] };
  }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/retry",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const projectTasks = opRepo
        ? await opRepo.listRunnerTasks(ctx, req.params.projectId)
        : runner.listTasks(ctx, req.params.projectId);
      const original = projectTasks.find((t) => t.taskId === req.params.taskId);
      if (!original) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${req.params.taskId}' não encontrada.`, 404);
      }
      const retried = runner.enqueue(ctx, {
        projectId: req.params.projectId,
        instruction: req.body?.instructionOverride?.trim() || original.instruction,
        priority: (["low", "normal", "high"].includes(original.priority) ? original.priority : "normal") as "low" | "normal" | "high"
      });
      if (opRepo) await opRepo.saveRunnerTask(ctx, retried);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task_retry",
        targetId: retried.taskId,
        metadata: {
          retriedFromTaskId: original.taskId,
          linkedRuleIds: req.body?.linkedRuleIds ?? [],
          linkedDocIds: req.body?.linkedDocIds ?? []
        }
      }).catch(() => undefined);
      return {
        ...retried,
        retriedFromTaskId: original.taskId,
        linkedRuleIds: req.body?.linkedRuleIds ?? [],
        linkedDocIds: req.body?.linkedDocIds ?? [],
        steps: [
          { step: 1, title: "Carregar Context Pack & Regras Vinculadas", status: "completed" },
          { step: 2, title: "Executar Agente Primário com Validação CASL", status: "running" },
          { step: 3, title: "Persistir Artefato Assinado & Handoff", status: "pending" }
        ]
      };
    }
  );
}

