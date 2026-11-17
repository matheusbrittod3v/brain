import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { BrainRunnerQueue } from "@noema/agent-runner";
import type { AuditLogger } from "@noema/audit-engine";
import type { AuthContext } from "@noema/auth";
import { dispatchChannelNotification, type HumanOpsChannel } from "@noema/connector-saas";
import { BrainError } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import { cancelRunnerSchedule, listRunnerSchedules } from "@noema/mcp-server";
import { notificationPreferenceAllows, type NotificationCategory, type NotificationPreferences } from "../notification-preferences.js";

export function registerRunnerRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    getNotificationPreferences: (ctx: AuthContext, projectId: string, accessPolicyId: string) => Promise<NotificationPreferences>;
    queueNotificationDigest: (
      ctx: AuthContext,
      input: {
        projectId: string;
        channel: HumanOpsChannel;
        category: NotificationCategory;
        targetId: string;
        title: string;
        frequency: "daily" | "weekly";
        accessPolicyId?: string;
      }
    ) => Promise<{ delivered: boolean; queued: boolean; channel: HumanOpsChannel; scheduledAt: string }>;
    runner: BrainRunnerQueue;
    opRepo?: PgOperationalRepository;
  }
) {
  const {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    getNotificationPreferences,
    queueNotificationDigest,
    runner,
    opRepo
  } = deps;

  app.post<{ Params: { projectId: string }; Body: { instruction: string; priority?: "low" | "normal" | "high" } }>(
    "/v1/projects/:projectId/runner/tasks",
    { schema: { body: Type.Object({ instruction: Type.String(), priority: Type.Optional(Type.String()) }) } },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const task = runner.enqueue(ctx, { projectId: req.params.projectId, instruction: req.body.instruction, priority: req.body.priority });
      if (opRepo) await opRepo.saveRunnerTask(ctx, task);
      return task;
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
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
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
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const questions = opRepo
        ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
        : runner.listQuestions(ctx, req.params.taskId);
      return { questions };
    }
  );

  app.post<{
    Params: { projectId: string; taskId: string; questionId: string };
    Body: { channel: HumanOpsChannel; webhookUrl?: string; reviewUrl?: string };
  }>("/v1/projects/:projectId/runner/tasks/:taskId/questions/:questionId/notify", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const questions = opRepo
      ? await opRepo.listRunnerTaskQuestions(ctx, req.params.projectId, req.params.taskId)
      : runner.listQuestions(ctx, req.params.taskId);
    const question = questions.find((entry) => entry.questionId === req.params.questionId);
    if (!question) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${req.params.questionId}' não encontrada para a tarefa.`, 404);
    if (question.status !== "pending") throw new BrainError("BRAIN_ERR_CONFLICT", "Somente perguntas pendentes podem ser notificadas.", 409);
    const preferences = await getNotificationPreferences(ctx, req.params.projectId, "internal-project");
    if (!notificationPreferenceAllows(preferences, req.body.channel, "runner_question")) {
      return { delivered: false, suppressed: true, channel: req.body.channel, reason: "Canal ou categoria desativada nas preferências pessoais." };
    }
    const envWebhookMap: Record<HumanOpsChannel, string | undefined> = {
      slack: process.env.NOEMA_SLACK_WEBHOOK_URL,
      teams: process.env.NOEMA_TEAMS_WEBHOOK_URL,
      jira: process.env.NOEMA_JIRA_WEBHOOK_URL,
      clickup: process.env.NOEMA_CLICKUP_WEBHOOK_URL,
      email: process.env.NOEMA_EMAIL_WEBHOOK_URL
    };
    const webhookUrl = req.body.webhookUrl ?? envWebhookMap[req.body.channel];
    if (!webhookUrl) return { delivered: false, channel: req.body.channel, reason: `Webhook para canal '${req.body.channel}' não configurado.` };
    const panelUrl = new URL(req.body.reviewUrl ?? `${process.env.NOEMA_CORS_ORIGIN ?? "http://localhost:3000"}`);
    panelUrl.searchParams.set("workspace", "agents");
    panelUrl.searchParams.set("projectId", req.params.projectId);
    if (preferences.frequency !== "immediate") {
      if (!envWebhookMap[req.body.channel]) return { delivered: false, channel: req.body.channel, reason: "Digest exige o webhook do canal configurado no servidor." };
      const queued = await queueNotificationDigest(ctx, {
        projectId: req.params.projectId,
        channel: req.body.channel,
        category: "runner_question",
        targetId: question.questionId,
        title: `Pergunta do Runner: ${question.question}`,
        frequency: preferences.frequency
      });
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "channel_notification",
        targetId: question.questionId,
        metadata: { channel: req.body.channel, queued: true, scheduledAt: queued.scheduledAt }
      });
      return queued;
    }
    const result = await dispatchChannelNotification({
      channel: req.body.channel,
      webhookUrl,
      projectId: req.params.projectId,
      proposalId: req.params.taskId,
      taskId: req.params.taskId,
      questionId: question.questionId,
      question: question.question,
      title: "Pergunta do Brain Runner",
      reviewUrl: panelUrl.toString(),
      idempotencyKey: `${req.params.projectId}:${req.params.taskId}:${question.questionId}:${req.body.channel}`
    });
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "channel_notification",
      targetId: question.questionId,
      metadata: { channel: req.body.channel, delivered: result.delivered, statusCode: result.statusCode }
    });
    return result;
  });
}
