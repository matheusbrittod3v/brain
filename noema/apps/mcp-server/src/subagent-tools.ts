import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@noema/auth";
import { BrainError } from "@noema/core";
import { evaluatePreDeployReadiness } from "@noema/enterprise-views";
import { computeProjectHealthReport } from "@noema/knowledge-health";
import { describeMcpTool, type McpConnectionProfileName } from "./connection-profile.js";
import type { NoemaRuntime } from "./index.js";
import { cancelRunnerSchedule, createRunnerSchedule, listRunnerSchedules } from "./runner-schedules.js";

const subagentMessageBuffer = new Map<string, Array<{ messageId: string; from: string; message: string; timestamp: string }>>();

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function ollamaUrl(override?: string): string {
  return (override ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
}

async function fetchOllamaTags(baseUrl: string): Promise<{
  available: boolean;
  baseUrl: string;
  models: Array<{
    name: string;
    sizeBytes: number;
    family?: string;
    parameterSize?: string;
    quantizationLevel?: string;
    modifiedAt?: string;
  }>;
  error?: string;
}> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) {
      return { available: false, baseUrl, models: [], error: `HTTP ${res.status}` };
    }
    const payload = (await res.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        modified_at?: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }>;
    };
    return {
      available: true,
      baseUrl,
      models: (payload.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? 0,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
        modifiedAt: m.modified_at
      }))
    };
  } catch (err) {
    return { available: false, baseUrl, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function callOllamaGenerate(baseUrl: string, model: string, prompt: string, timeoutMs = 45_000): Promise<{
  response: string;
  evalCount?: number;
  promptEvalCount?: number;
  totalDurationMs?: number;
}> {
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `Ollama retornou HTTP ${res.status}: ${text.slice(0, 200)}`, 503);
  }
  const data = (await res.json()) as {
    response?: string;
    eval_count?: number;
    prompt_eval_count?: number;
    total_duration?: number;
  };
  return {
    response: (data.response ?? "").trim(),
    evalCount: data.eval_count,
    promptEvalCount: data.prompt_eval_count,
    totalDurationMs: typeof data.total_duration === "number" ? Math.round(data.total_duration / 1_000_000) : undefined
  };
}

export async function collectVerifiedByEdges(
  graph: NoemaRuntime["graph"],
  ctx: AuthContext,
  projectId: string,
  items: ReadonlyArray<{ id: string; type: string; status: string; accessPolicyId?: string }>
) {
  const edges: Array<{
    tenantId: string;
    fromProjectId: string;
    toProjectId: string;
    fromItemId: string;
    toItemId: string;
    fromPolicyId: string;
    toPolicyId: string;
    relationType: "VERIFIED_BY";
    isInferred: false;
    confidence: number;
  }> = [];
  const seen = new Set<string>();
  for (const rule of items.filter((item) => item.type === "business_rule" && item.status !== "deprecated")) {
    const related = await graph.traverseRelated(ctx, { projectId, itemId: rule.id }, 2);
    for (const hit of related) {
      if (hit.via !== "VERIFIED_BY") continue;
      const key = `${rule.id}->${hit.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const policy = rule.accessPolicyId ?? "internal-project";
      edges.push({
        tenantId: ctx.tenantId,
        fromProjectId: projectId,
        toProjectId: projectId,
        fromItemId: rule.id,
        toItemId: hit.itemId,
        fromPolicyId: policy,
        toPolicyId: policy,
        relationType: "VERIFIED_BY",
        isInferred: false,
        confidence: 1
      });
    }
  }
  return edges;
}

export function registerSubagentMcpTools(
  server: McpServer,
  runtime: NoemaRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  // 1. Conversa e interação contínua com o Subagent
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

  // 2. Uso direto dos modelos locais (Ollama) como Subagent especialista
  server.tool(
    "brain_local_models_list",
    describeMcpTool(profile, "Lista os modelos de IA baixados localmente no Ollama (ex.: gemma2:2b, gemma:2b, bge-m3) e status do serviço."),
    {
      ollamaBaseUrl: z.string().url().optional()
    },
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
    async ({ projectId, prompt, model, intent, maxTokens, includeContext = true, ollamaBaseUrl }) => {
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
        let recommendedAction: "approve" | "review" | "investigate_conflict" = ruleConflicts.length > 0 ? "investigate_conflict" : "review";
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

  // 3. Ciclo de vida, agendamento e locks
  server.tool(
    "brain_runner_schedule_create",
    describeMcpTool(profile, "Agenda uma execução recorrente do Brain Runner via expressão cron UTC."),
    {
      projectId: z.string().min(1),
      instruction: z.string().min(1),
      cron: z.string().min(5),
      priority: z.enum(["low", "normal", "high"]).optional()
    },
    async ({ projectId, instruction, cron, priority = "normal" }) => {
      assertProjectAccess(ctx, projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (runtime.scheduleRunnerTask) {
        const res = await runtime.scheduleRunnerTask({
          tenantId: ctx.tenantId,
          projectId,
          actorId: ctx.actorId,
          accessPolicyId: auditPolicyId,
          instruction,
          priority,
          cron
        });
        return okJson({ ...res, projectId, cron, instruction, priority, status: "scheduled" });
      }
      if (!databaseUrl) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Agendamento cron requer DATABASE_URL configurada.", 503);
      }
      const scheduleId = await createRunnerSchedule(
        { tenantId: ctx.tenantId, projectId, actorId: ctx.actorId, accessPolicyId: auditPolicyId, instruction, priority },
        cron,
        databaseUrl
      );
      return okJson({ scheduleId, projectId, cron, instruction, priority, status: "scheduled" });
    }
  );

  server.tool(
    "brain_runner_schedule_list",
    describeMcpTool(profile, "Lista os agendamentos recorrentes ativos do Brain Runner para o projeto."),
    {
      projectId: z.string().min(1)
    },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!databaseUrl) {
        return okJson({ projectId, schedules: [], note: "DATABASE_URL não configurada neste runtime." });
      }
      const schedules = await listRunnerSchedules({ tenantId: ctx.tenantId, projectId }, databaseUrl);
      return okJson({ projectId, count: schedules.length, schedules });
    }
  );

  server.tool(
    "brain_runner_schedule_cancel",
    describeMcpTool(profile, "Cancela um agendamento recorrente do Brain Runner."),
    {
      projectId: z.string().min(1),
      scheduleId: z.string().min(1)
    },
    async ({ projectId, scheduleId }) => {
      assertProjectAccess(ctx, projectId);
      const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Agendamento cron requer DATABASE_URL configurada.", 503);
      }
      const cancelled = await cancelRunnerSchedule({ tenantId: ctx.tenantId, projectId }, scheduleId, databaseUrl);
      return okJson({ projectId, scheduleId, cancelled });
    }
  );

  server.tool(
    "brain_runner_retry",
    describeMcpTool(profile, "Reenfileira uma tarefa do Brain Runner reaproveitando a instrução e prioridade originais."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      instructionOverride: z.string().optional()
    },
    async ({ projectId, taskId, instructionOverride }) => {
      assertProjectAccess(ctx, projectId);
      const tasks = runtime.opRepo
        ? await runtime.opRepo.listRunnerTasks(ctx, projectId)
        : runtime.runner.listTasks(ctx, projectId);
      const original = tasks.find((t) => t.taskId === taskId);
      if (!original) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada no projeto '${projectId}'.`, 404);
      }
      const retried = runtime.runner.enqueue(ctx, {
        projectId,
        instruction: instructionOverride?.trim() || original.instruction,
        priority: (original.priority as "low" | "normal" | "high") ?? "normal"
      });
      if (runtime.opRepo) {
        await runtime.opRepo.saveRunnerTask(ctx, retried);
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "runner_task_retry",
        targetId: retried.taskId,
        metadata: { retriedFromTaskId: taskId }
      });
      return okJson({ retriedFromTaskId: taskId, task: retried });
    }
  );

  server.tool(
    "brain_release_lease",
    describeMcpTool(profile, "Libera imediatamente o lease de tarefa/arquivos adquirido com brain_acquire_lease."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1)
    },
    async ({ projectId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      const released = runtime.opRepo ? await runtime.opRepo.releaseLease(ctx, projectId, taskId) : false;
      return okJson({ released, projectId, taskId });
    }
  );

  // 4. Saídas, verificação e consumo
  server.tool(
    "brain_subagent_artifacts",
    describeMcpTool(profile, "Lista saídas, handoffs e propostas associadas a uma tarefa do subagent."),
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
      const handoff = runtime.opRepo
        ? await runtime.opRepo.getLatestHandoff(ctx, projectId, taskId).catch(() => undefined)
        : runtime.handoffs.resumeHandoff(ctx, { projectId, taskId });
      const proposals = runtime.approvals ? await runtime.approvals.listPending(ctx, projectId) : [];
      return okJson({
        projectId,
        taskId,
        status: task.status,
        resultSummary: task.resultSummary ?? null,
        handoff: handoff ?? null,
        pendingProposalsCount: proposals.length
      });
    }
  );

  server.tool(
    "brain_subagent_verify",
    describeMcpTool(
      profile,
      "Executa auditoria cruzada (arestas VERIFIED_BY no grafo, saúde das regras e prontidão de deploy) e retorna parecer estruturado. Nota: a Matriz Corporativa exige também execução de teste 'passed' (CI) além da aresta VERIFIED_BY."
    ),
    {
      projectId: z.string().min(1),
      targetIds: z.array(z.string()).optional()
    },
    async ({ projectId, targetIds }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const items = hits.map((h) => h.item);
      const verifiedEdges = await collectVerifiedByEdges(runtime.graph, ctx, projectId, items);
      const health = computeProjectHealthReport(items, verifiedEdges);
      const totalRules = items.filter((item) => item.type === "business_rule" && item.status !== "deprecated").length;
      const coveredRules = Math.max(0, totalRules - health.untestedRuleIds.length);
      const coveragePercent = totalRules > 0 ? Math.round((coveredRules / totalRules) * 100) : 100;
      const readiness = evaluatePreDeployReadiness({
        coveragePercent,
        sbomPackages: [],
        healthScore: health.healthScore
      });
      const targeted = targetIds && targetIds.length > 0
        ? items.filter((item) => targetIds.includes(item.id)).map((item) => ({ id: item.id, status: item.status, type: item.type }))
        : [];
      const verdict = readiness.ready && health.untestedRuleIds.length === 0 ? "approved" : "needs_changes";
      return okJson({
        projectId,
        verdict,
        healthScore: health.healthScore,
        untestedRuleIds: health.untestedRuleIds,
        staleItemIds: health.staleItemIds,
        readiness,
        targeted,
        coverageNote:
          "healthScore reflete vínculos estruturais VERIFIED_BY no grafo; a Matriz Corporativa (qaCoverage) exige execução de teste 'passed' no HEAD da main.",
        checkedAt: new Date().toISOString()
      });
    }
  );

  server.tool(
    "brain_subagent_usage",
    describeMcpTool(profile, "Consulta o consumo agregado de execuções, status e uso de modelos do Brain Runner no projeto."),
    {
      projectId: z.string().min(1)
    },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const tasks = runtime.opRepo
        ? await runtime.opRepo.listRunnerTasks(ctx, projectId, 200)
        : runtime.runner.listTasks(ctx, projectId);
      const byStatus: Record<string, number> = {};
      const byModel: Record<string, { calls: number; totalTokens: number }> = {};
      let totalTokens = 0;

      for (const task of tasks) {
        byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
        const meta = (task as { resultMetadata?: { modelUsage?: { model?: string; totalTokens?: number } } }).resultMetadata;
        const model = meta?.modelUsage?.model;
        if (model) {
          const tokens = typeof meta?.modelUsage?.totalTokens === "number" ? meta.modelUsage.totalTokens : 0;
          const bucket = byModel[model] ?? { calls: 0, totalTokens: 0 };
          bucket.calls += 1;
          bucket.totalTokens += tokens;
          byModel[model] = bucket;
          totalTokens += tokens;
        }
      }
      return okJson({
        projectId,
        totalTasks: tasks.length,
        totalTokens,
        byStatus,
        byModel
      });
    }
  );

  server.tool(
    "brain_graph_relate",
    describeMcpTool(
      profile,
      "Cria uma aresta explícita no grafo de conhecimento (ex.: VERIFIED_BY entre regra e teste, IMPLEMENTS, GOVERNED_BY, DEPENDS_ON). Aresta VERIFIED_BY atualiza o healthScore estrutural; a Matriz Corporativa exige ainda execução de teste 'passed'."
    ),
    {
      projectId: z.string().min(1),
      fromItemId: z.string().min(1),
      toItemId: z.string().min(1),
      relationType: z.enum([
        "IMPLEMENTS",
        "GOVERNED_BY",
        "DEPENDS_ON",
        "DECIDED_BY",
        "VERIFIED_BY",
        "BLOCKED_BY",
        "SUPERSEDES",
        "IMPACTS",
        "CONSUMES_API",
        "PUBLISHES_EVENT",
        "SUBSCRIBES_TO",
        "CO_ACCESSED_WITH"
      ]),
      evidenceUri: z.string().optional(),
      confidence: z.number().min(0).max(1).optional()
    },
    async ({ projectId, fromItemId, toItemId, relationType, evidenceUri, confidence }) => {
      assertProjectAccess(ctx, projectId);
      const fromItem = await runtime.retrieval.getItem(ctx, projectId, fromItemId);
      const toItem = await runtime.retrieval.getItem(ctx, projectId, toItemId);
      const fromPolicyId = fromItem?.accessPolicyId ?? auditPolicyId;
      const toPolicyId = toItem?.accessPolicyId ?? auditPolicyId;
      const edge = {
        tenantId: ctx.tenantId,
        fromProjectId: projectId,
        toProjectId: projectId,
        fromItemId,
        toItemId,
        fromPolicyId,
        toPolicyId,
        relationType,
        isInferred: false as const,
        confidence: confidence ?? 1.0,
        ...(evidenceUri ? { evidenceUri } : {})
      };
      await runtime.graph.addEdge(edge, ctx);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "graph_relation",
        targetId: `${fromItemId}->${toItemId}`,
        metadata: { relationType }
      });
      return okJson({ created: true, projectId, edge });
    }
  );
}
