import { randomUUID } from "node:crypto";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";

export interface RunnerTask {
  taskId: string;
  tenantId: string;
  projectId: string;
  instruction: string;
  priority: "low" | "normal" | "high";
  draftOnly: true;
  maxSteps: number;
  timeoutSeconds: number;
  status: "queued" | "running" | "awaiting_human" | "completed" | "escalated";
  resultSummary?: string;
  modelUsage?: ModelUsage;
  createdAt: string;
}

export interface ModelUsage {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  providerCostUsd: number | null;
  costBasis: "self_hosted_no_api_fee" | "provider_reported" | "unknown";
}

export interface RunnerTaskQuestion {
  questionId: string;
  taskId: string;
  tenantId: string;
  projectId: string;
  question: string;
  status: "pending" | "answered";
  response?: string;
  idempotencyKey?: string;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

export const DESTRUCTIVE_COMMANDS = /\b(rm\s+-rf|drop\s+table|git\s+push\s+--force|mkfs)\b/i;

export class BrainRunnerQueue {
  private readonly tasks: RunnerTask[] = [];
  private readonly questions = new Map<string, RunnerTaskQuestion[]>();

  enqueue(
    ctx: AuthContext,
    input: { projectId: string; instruction: string; priority?: "low" | "normal" | "high"; maxSteps?: number }
  ): RunnerTask {
    if (DESTRUCTIVE_COMMANDS.test(input.instruction)) {
      const escalated: RunnerTask = {
        taskId: `RUN-${randomUUID().slice(0, 8)}`,
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        instruction: input.instruction,
        priority: input.priority ?? "normal",
        draftOnly: true,
        maxSteps: Math.min(input.maxSteps ?? 10, 30),
        timeoutSeconds: 120,
        status: "escalated",
        resultSummary: "Bloqueado pelo guardrail de execução (comando destrutivo).",
        createdAt: new Date().toISOString()
      };
      this.tasks.push(escalated);
      return escalated;
    }

    const task: RunnerTask = {
      taskId: `RUN-${randomUUID().slice(0, 8)}`,
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      instruction: input.instruction,
      priority: input.priority ?? "normal",
      draftOnly: true,
      maxSteps: Math.min(input.maxSteps ?? 10, 30),
      timeoutSeconds: 120,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    this.tasks.push(task);
    return task;
  }

  getTask(ctx: AuthContext, taskId: string): RunnerTask | undefined {
    return this.tasks.find((t) => t.tenantId === ctx.tenantId && t.taskId === taskId);
  }

  askQuestion(ctx: AuthContext, taskId: string, question: string): RunnerTaskQuestion {
    if (question.trim().length === 0) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A pergunta não pode estar vazia.", 400);
    }
    const task = this.getTask(ctx, taskId);
    if (!task || !ctx.allowedProjects.includes(task.projectId)) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada.`, 404);
    }
    if (!["queued", "running", "awaiting_human"].includes(task.status)) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${taskId}' não pode receber perguntas no status '${task.status}'.`, 409);
    }
    const taskQuestions = this.questions.get(`${ctx.tenantId}:${taskId}`) ?? [];
    if (taskQuestions.some((entry) => entry.status === "pending")) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Tarefa '${taskId}' já tem uma pergunta pendente.`, 409);
    }
    const now = new Date().toISOString();
    const entry: RunnerTaskQuestion = {
      questionId: randomUUID(),
      taskId,
      tenantId: ctx.tenantId,
      projectId: task.projectId,
      question: question.trim(),
      status: "pending",
      createdAt: now
    };
    taskQuestions.push(entry);
    this.questions.set(`${ctx.tenantId}:${taskId}`, taskQuestions);
    task.status = "awaiting_human";
    return entry;
  }

  answerQuestion(
    ctx: AuthContext,
    taskId: string,
    input: { questionId: string; response: string; idempotencyKey: string }
  ): { question: RunnerTaskQuestion; duplicate: boolean } {
    const task = this.getTask(ctx, taskId);
    if (!task || !ctx.allowedProjects.includes(task.projectId)) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada.`, 404);
    }
    const question = (this.questions.get(`${ctx.tenantId}:${taskId}`) ?? []).find((entry) => entry.questionId === input.questionId);
    if (!question) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${input.questionId}' não encontrada para a tarefa.`, 404);
    }
    const response = input.response.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!response || !idempotencyKey) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Resposta e idempotencyKey não podem estar vazias.", 400);
    }
    if (question.status === "answered") {
      if (question.idempotencyKey === idempotencyKey && question.response === response) {
        return { question, duplicate: true };
      }
      throw new BrainError("BRAIN_ERR_CONFLICT", `Pergunta '${input.questionId}' já foi respondida.`, 409);
    }
    question.status = "answered";
    question.response = response;
    question.idempotencyKey = idempotencyKey;
    question.answeredBy = ctx.actorId;
    question.answeredAt = new Date().toISOString();
    task.status = "queued";
    return { question, duplicate: false };
  }

  listQuestions(ctx: AuthContext, taskId: string): RunnerTaskQuestion[] {
    const task = this.getTask(ctx, taskId);
    if (!task || !ctx.allowedProjects.includes(task.projectId)) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada.`, 404);
    }
    return [...(this.questions.get(`${ctx.tenantId}:${taskId}`) ?? [])];
  }

  listPendingQuestions(ctx: AuthContext, projectId: string): RunnerTaskQuestion[] {
    if (!ctx.allowedProjects.includes(projectId)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Projeto '${projectId}' não permitido.`, 403);
    }
    return [...this.questions.values()].flat().filter(
      (entry) => entry.tenantId === ctx.tenantId && entry.projectId === projectId && entry.status === "pending"
    );
  }

  listTasks(ctx: AuthContext, projectId: string): RunnerTask[] {
    return this.tasks.filter((t) => t.tenantId === ctx.tenantId && t.projectId === projectId);
  }
}

