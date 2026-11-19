import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import { describeMcpTool, type McpConnectionProfileName } from "../connection-profile.js";
import { okJson } from "../helpers.js";
import type { BrainRuntime } from "../runtime.js";
import { callOllamaGenerate, fetchOllamaTags, ollamaUrl } from "./ollama.js";

const subagentMessageBuffer = new Map<string, Array<{ messageId: string; from: string; message: string; timestamp: string }>>();

export function registerSubagentMessagingTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  server.tool(
    "brain_subagent_send_message",
    describeMcpTool(profile, "Envia uma mensagem ou correção de rota para uma execução/subagent do Brain Runner já em andamento."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      message: z.string().min(1)
    },
    async ({ projectId, taskId, message }) => {
      assertProjectAccess(ctx, projectId);
      const tasks = runtime.opRepo
        ? await runtime.opRepo.listRunnerTasks(ctx, projectId)
        : runtime.runner.listTasks(ctx, projectId);
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada no projeto '${projectId}'.`, 404);
      }
      const key = `${ctx.tenantId}:${projectId}:${taskId}`;
      const entry = {
        messageId: `MSG-${randomUUID().slice(0, 8)}`,
        from: ctx.actorId,
        message: message.trim(),
        timestamp: new Date().toISOString()
      };
      const list = subagentMessageBuffer.get(key) ?? [];
      list.push(entry);
      subagentMessageBuffer.set(key, list);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "runner_task_message",
        targetId: taskId,
        metadata: { messageId: entry.messageId, message: entry.message }
      });
      return okJson({ delivered: true, projectId, taskId, taskStatus: task.status, ...entry });
    }
  );

  server.tool(
    "brain_answer_question",
    describeMcpTool(profile, "Responde a uma pergunta pendente aberta por um subagent via brain_ask_human e destrava a execução."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      questionId: z.string().min(1),
      response: z.string().min(1),
      idempotencyKey: z.string().optional()
    },
    async ({ projectId, taskId, questionId, response, idempotencyKey }) => {
      assertProjectAccess(ctx, projectId);
      const key = idempotencyKey?.trim() || `mcp-${randomUUID()}`;
      if (runtime.opRepo) {
        const answered = await runtime.opRepo.answerRunnerQuestion(ctx, {
          projectId,
          taskId,
          questionId,
          response,
          idempotencyKey: key
        });
        await runtime.audit.record({
          tenantId: ctx.tenantId,
          projectId,
          accessPolicyId: auditPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "runner_question_answer",
          targetId: questionId,
          metadata: { taskId, duplicate: answered.duplicate }
        });
        return okJson({ projectId, taskId, ...answered });
      }
      const answered = runtime.runner.answerQuestion(ctx, taskId, { questionId, response, idempotencyKey: key });
      return okJson({
        projectId,
        taskId,
        questionId: answered.question.questionId,
        status: answered.question.status,
        duplicate: answered.duplicate,
        responseRecorded: true
      });
    }
  );

  server.tool(
    "brain_subagent_logs",
    describeMcpTool(profile, "Consulta o progresso, mensagens enviadas, perguntas e metadados de execução de um subagent."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1)
    },
    async ({ projectId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      const tasks = runtime.opRepo
        ? await runtime.opRepo.listRunnerTasks(ctx, projectId)
        : runtime.runner.listTasks(ctx, projectId);
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada no projeto '${projectId}'.`, 404);
      }
      const questions = runtime.opRepo
        ? await runtime.opRepo.listRunnerTaskQuestions(ctx, projectId, taskId)
        : runtime.runner.listQuestions(ctx, taskId);
      const messages = subagentMessageBuffer.get(`${ctx.tenantId}:${projectId}:${taskId}`) ?? [];
      return okJson({
        projectId,
        taskId,
        status: task.status,
        priority: task.priority,
        instruction: task.instruction,
        resultSummary: task.resultSummary ?? null,
        resultMetadata: (task as { resultMetadata?: unknown }).resultMetadata ?? null,
        messages,
        questions
      });
    }
  );

  server.tool(
    "brain_local_models_list",
    describeMcpTool(profile, "Lista os modelos de IA baixados localmente no Ollama (ex.: gemma2:2b, gemma:2b, bge-m3) e status do serviço."),
    { ollamaBaseUrl: z.string().url().optional() },
    async ({ ollamaBaseUrl }) => okJson(await fetchOllamaTags(ollamaUrl(ollamaBaseUrl)))
  );

  server.tool(
    "brain_subagent_ask_local",
    describeMcpTool(profile, "Aciona um modelo local do Ollama (ex.: gemma2:2b) com o ContextPack do projeto para análises, resumos e rascunhos sem custo em nuvem."),
    {
      projectId: z.string().min(1),
      prompt: z.string().min(1),
      model: z.string().optional(),
      intent: z.enum(["implement", "debug", "impact", "review", "business_qa", "onboarding"]).optional(),
      maxTokens: z.number().int().min(200).max(8000).optional(),
      includeContext: z.boolean().optional(),
      ollamaBaseUrl: z.string().url().optional()
    },
    async ({ projectId, prompt, model, intent, includeContext = true, ollamaBaseUrl }) => {
      assertProjectAccess(ctx, projectId);
      const chosenModel = model?.trim() || process.env.LLM_MODEL || "gemma2:2b";
      const baseUrl = ollamaUrl(ollamaBaseUrl);
      let contextSection = "";
      let contextItemsUsed = 0;
      if (includeContext) {
        const pack = await runtime.contextEngine.buildContextPack(ctx, {
          projectId,
          task: prompt,
          intent: intent ?? "business_qa"
        });
        const entries = [...pack.context.businessRules, ...pack.context.architecture];
        contextItemsUsed = pack.sources.length || entries.length;
        if (entries.length > 0) {
          contextSection = entries
            .slice(0, 12)
            .map((entry) => `[${entry.id}] ${entry.title}\n${entry.summary.slice(0, 800)}`)
            .join("\n\n---\n\n");
        }
      }
      const fullPrompt = contextSection
        ? `Você é um subagente técnico local do projeto "${projectId}". Use apenas o contexto verificado abaixo quando aplicável.\n\n### Contexto do Projeto\n${contextSection}\n\n### Tarefa\n${prompt}`
        : prompt;

      const generated = await callOllamaGenerate(baseUrl, chosenModel, fullPrompt);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "local_subagent_call",
        targetId: chosenModel,
        metadata: { contextItemsUsed, evalCount: generated.evalCount, totalDurationMs: generated.totalDurationMs }
      });
      return okJson({
        projectId,
        model: chosenModel,
        contextItemsUsed,
        answer: generated.response,
        evalCount: generated.evalCount ?? null,
        promptEvalCount: generated.promptEvalCount ?? null,
        totalDurationMs: generated.totalDurationMs ?? null
      });
    }
  );

  server.tool(
    "brain_subagent_triage_inbox",
    describeMcpTool(profile, "Pré-analisa rascunhos e propostas pendentes na Caixa de Entrada, apontando conflitos com regras aprovadas e prioridade."),
    {
      projectId: z.string().min(1),
      model: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional()
    },
    async ({ projectId, model, limit = 10 }) => {
      assertProjectAccess(ctx, projectId);
      const allHits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 100 });
      const drafts = allHits.filter((h) => h.item.status === "draft").slice(0, limit);
      const approvedRules = allHits.filter((h) => h.item.status === "approved" && h.item.type === "business_rule");
      const pendingProposals = runtime.approvals ? (await runtime.approvals.listPending(ctx, projectId)).slice(0, limit) : [];

      const itemsToTriage = [
        ...pendingProposals.map((p) => ({
          kind: "proposal" as const,
          id: p.proposalId,
          title: p.item.title,
          content: p.item.content,
          requestedBy: p.requestedBy
        })),
        ...drafts.map((d) => ({
          kind: "draft" as const,
          id: d.item.id,
          title: d.item.title,
          content: d.item.content,
          requestedBy: "ingestion"
        }))
      ].slice(0, limit);

      const baseUrl = ollamaUrl();
      const tags = await fetchOllamaTags(baseUrl);
      const chosenModel = model?.trim() || process.env.LLM_MODEL || "gemma2:2b";
      const canUseOllama = tags.available && tags.models.some((m) => m.name.startsWith(chosenModel.split(":")[0]!));

      const results = [];
      for (const item of itemsToTriage) {
        const ruleConflicts = approvedRules
          .filter((r) => r.item.title.toLowerCase() === item.title.toLowerCase())
          .map((r) => r.item.id);
        let summary = `Item '${item.title}' com ${item.content.length} caracteres.`;
        const recommendedAction: "approve" | "review" | "investigate_conflict" = ruleConflicts.length > 0 ? "investigate_conflict" : "review";
        if (canUseOllama) {
          try {
            const ai = await callOllamaGenerate(
              baseUrl,
              chosenModel,
              `Resuma em até 2 frases em português se este rascunho de conhecimento deve ser aprovado ou revisado.\nTítulo: ${item.title}\nConteúdo: ${item.content.slice(0, 1200)}`,
              15_000
            );
            if (ai.response) summary = ai.response;
          } catch {
            // Mantém triagem heurística se o modelo local demorar
          }
        }
        results.push({ ...item, content: undefined, ruleConflicts, recommendedAction, summary });
      }
      return okJson({
        projectId,
        triageEngine: canUseOllama ? `ollama:${chosenModel}` : "heuristic",
        totalAnalyzed: results.length,
        items: results
      });
    }
  );
}

