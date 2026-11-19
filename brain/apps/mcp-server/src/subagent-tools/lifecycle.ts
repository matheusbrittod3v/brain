import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import { evaluatePreDeployReadiness } from "@brain/enterprise-views";
import { computeProjectHealthReport } from "@brain/knowledge-health";
import { describeMcpTool, type McpConnectionProfileName } from "../connection-profile.js";
import { okJson } from "../helpers.js";
import { cancelRunnerSchedule, createRunnerSchedule, listRunnerSchedules } from "../runner-schedules.js";
import type { BrainRuntime } from "../runtime.js";
import { collectVerifiedByEdges } from "./ollama.js";

export function registerSubagentLifecycleTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
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
    { projectId: z.string().min(1) },
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
    { projectId: z.string().min(1), taskId: z.string().min(1) },
    async ({ projectId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      const released = runtime.opRepo ? await runtime.opRepo.releaseLease(ctx, projectId, taskId) : false;
      return okJson({ released, projectId, taskId });
    }
  );

  server.tool(
    "brain_subagent_artifacts",
    describeMcpTool(profile, "Lista saídas, handoffs e propostas associadas a uma tarefa do subagent."),
    { projectId: z.string().min(1), taskId: z.string().min(1) },
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
    { projectId: z.string().min(1) },
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
      return okJson({ projectId, totalTasks: tasks.length, totalTokens, byStatus, byModel });
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

