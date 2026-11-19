import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import { buildIncidentToCodeMap, evaluatePreDeployReadiness } from "@brain/enterprise-views";
import { computeProjectHealthReport } from "@brain/knowledge-health";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

export function registerExtendedRunnerOpsTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  server.tool(
    "brain_check_file_leases",
    describeMcpTool(profile, "Verifica se outros agentes ou desenvolvedores possuem leases ativos sobre os arquivos alvo."),
    {
      projectId: z.string().min(1),
      targetFiles: z.array(z.string().min(1)).min(1),
      excludeTaskId: z.string().optional()
    },
    async ({ projectId, targetFiles, excludeTaskId }) => {
      assertProjectAccess(ctx, projectId);
      const conflicts = runtime.opRepo
        ? await runtime.opRepo.findOverlappingFileLeases(ctx, projectId, excludeTaskId ?? "", targetFiles)
        : [];
      return okJson({ projectId, targetFiles, hasConflicts: conflicts.length > 0, conflicts });
    }
  );

  server.tool(
    "brain_acquire_lease",
    describeMcpTool(profile, "Adquire ou renova um lease de tarefa/branch com lista de arquivos alvo e retorna conflitos existentes."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().min(1),
      targetFiles: z.array(z.string()).optional(),
      ttlMinutes: z.number().int().min(1).max(480).optional()
    },
    async ({ projectId, taskId, branch, targetFiles, ttlMinutes }) => {
      assertProjectAccess(ctx, projectId);
      const files = targetFiles ?? [];
      const ttlMs = (ttlMinutes ?? 30) * 60_000;
      let conflicts: Array<{ taskId: string; actorId: string; branch: string; overlappingFiles: string[] }> = [];
      if (runtime.opRepo) {
        conflicts = await runtime.opRepo.findOverlappingFileLeases(ctx, projectId, taskId, files);
        await runtime.opRepo.upsertLease(ctx, projectId, taskId, branch, ttlMs, files);
      } else {
        runtime.handoffs.createHandoff(ctx, {
          projectId,
          taskId,
          fromAgent: ctx.actorId,
          repoUrl: ".",
          branch,
          baseCommitSha: "HEAD",
          modifiedFiles: files,
          workingTreeDirty: false,
          testsExecuted: [],
          decisions: [],
          nextSteps: []
        });
      }
      return okJson({ acquired: true, projectId, taskId, branch, targetFiles: files, conflicts });
    }
  );

  server.tool(
    "brain_runner_status",
    describeMcpTool(profile, "Consulta o status, resultado e consumo de modelo de uma tarefa delegada ao Brain Runner."),
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
      return okJson({ projectId, task });
    }
  );

  server.tool(
    "brain_runner_cancel",
    describeMcpTool(profile, "Cancela uma tarefa enfileirada ou em execução no Brain Runner."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1)
    },
    async ({ projectId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      if (runtime.opRepo) {
        const result = await runtime.opRepo.cancelRunnerTask(ctx, projectId, taskId);
        if (!result) {
          throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada.`, 404);
        }
        return okJson({ ...result, cancelled: result.status === "cancelled" });
      }
      const task = runtime.runner.listTasks(ctx, projectId).find((t) => t.taskId === taskId);
      if (!task) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Tarefa '${taskId}' não encontrada.`, 404);
      }
      task.status = "escalated";
      return okJson({ projectId, taskId, cancelled: true, status: task.status });
    }
  );

  server.tool(
    "brain_ask_human",
    describeMcpTool(profile, "Registra uma pergunta bloqueante vinculada a uma tarefa do Runner e pausa até resposta humana."),
    {
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      question: z.string().min(1)
    },
    async ({ projectId, taskId, question }) => {
      assertProjectAccess(ctx, projectId);
      if (runtime.opRepo) {
        const created = await runtime.opRepo.createRunnerQuestion(ctx, {
          questionId: `Q-${randomUUID().slice(0, 8)}`,
          projectId,
          taskId,
          accessPolicyId: auditPolicyId,
          question
        });
        return okJson(created);
      }
      const created = runtime.runner.askQuestion(ctx, taskId, question);
      return okJson({ projectId, taskId, questionId: created.questionId, status: created.status });
    }
  );

  server.tool(
    "brain_get_question_answer",
    describeMcpTool(profile, "Consulta perguntas pendentes e respostas humanas de uma tarefa do Brain Runner."),
    {
      projectId: z.string().min(1),
      taskId: z.string().optional()
    },
    async ({ projectId, taskId }) => {
      assertProjectAccess(ctx, projectId);
      if (runtime.opRepo) {
        const questions = taskId
          ? await runtime.opRepo.listRunnerTaskQuestions(ctx, projectId, taskId)
          : await runtime.opRepo.listPendingRunnerQuestions(ctx, projectId);
        return okJson({ projectId, questions });
      }
      const questions = taskId ? runtime.runner.listQuestions(ctx, taskId) : runtime.runner.listPendingQuestions(ctx, projectId);
      return okJson({ projectId, questions });
    }
  );

  server.tool(
    "brain_cross_service_blast_radius",
    describeMcpTool(profile, "Calcula o raio de explosão cross-service para alteração em um contrato ou serviço."),
    {
      projectId: z.string().min(1),
      contractId: z.string().min(1)
    },
    async ({ projectId, contractId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.crossServiceRegistry) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Registro cross-service indisponível neste runtime.", 503);
      }
      const affected = await runtime.crossServiceRegistry.computeDistributedBlastRadius(ctx, contractId);
      return okJson({ projectId, contractId, affected });
    }
  );

  server.tool(
    "brain_scaffold_recommendations",
    describeMcpTool(profile, "Retorna ADRs aprovados de referência e preferências do developer_profile para scaffold."),
    {
      projectId: z.string().min(1),
      query: z.string().optional()
    },
    async ({ projectId, query }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, {
        projectId,
        query: query ?? "architecture decision",
        domains: [3],
        limit: 10
      });
      const adrs = hits
        .map((h) => h.item)
        .filter((i) => i.type === "architecture_decision" && i.status === "approved");
      const developerProfile = runtime.opRepo ? await runtime.opRepo.getDeveloperProfile(ctx) : undefined;
      return okJson({
        projectId,
        adrs: adrs.map((a) => ({ id: a.id, title: a.title, sourceUri: a.sourceUri, summary: a.content.slice(0, 300) })),
        developerProfile
      });
    }
  );

  server.tool(
    "brain_pre_deploy_readiness",
    describeMcpTool(profile, "Avalia prontidão pré-deploy (cobertura de regras, saúde do conhecimento, CVEs SBOM e incidentes)."),
    {
      projectId: z.string().min(1),
      coveragePercent: z.number().min(0).max(100),
      minCoveragePercent: z.number().min(0).max(100).optional(),
      openCriticalIncidents: z.number().int().min(0).optional(),
      guardianPassed: z.boolean().optional()
    },
    async ({ projectId, coveragePercent, minCoveragePercent, openCriticalIncidents, guardianPassed }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 300 });
      const report = computeProjectHealthReport(hits.map((h) => h.item), []);
      const readiness = evaluatePreDeployReadiness({
        coveragePercent,
        minCoveragePercent,
        sbomPackages: [],
        healthScore: report.healthScore,
        openCriticalIncidents,
        guardianPassed
      });
      return okJson({ projectId, healthScore: report.healthScore, readiness });
    }
  );

  server.tool(
    "brain_incident_to_code",
    describeMcpTool(profile, "Correlaciona um incidente ou erro de produção com símbolos de código, serviços e regras de negócio."),
    {
      projectId: z.string().min(1),
      incidentId: z.string().min(1),
      title: z.string().min(1),
      service: z.string().optional(),
      endpoint: z.string().optional(),
      tags: z.array(z.string()).optional()
    },
    async ({ projectId, incidentId, title, service, endpoint, tags }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: title, limit: 100 });
      const mapping = buildIncidentToCodeMap({
        incidents: [{
          id: incidentId,
          title,
          severity: "high",
          service,
          endpoint,
          tags
        }],
        items: hits.map((h) => h.item)
      });
      return okJson({ projectId, mapping: mapping[0] });
    }
  );

  server.tool(
    "brain_list_proposals",
    describeMcpTool(profile, "Lista propostas pendentes ou com solicitação de revisão na fila de aprovações."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.approvals) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Fila de aprovação indisponível neste runtime MCP.", 503);
      }
      const proposals = await runtime.approvals.listPending(ctx, projectId);
      return okJson({ projectId, count: proposals.length, proposals });
    }
  );

  server.tool(
    "brain_revise_proposal",
    describeMcpTool(profile, "Reenvia uma proposta após changes_requested, incrementando a versão para nova revisão humana."),
    {
      projectId: z.string().min(1),
      proposalId: z.string().min(1),
      title: z.string().optional(),
      content: z.string().min(1)
    },
    async ({ projectId, proposalId, title, content }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.approvals) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Fila de aprovação indisponível neste runtime MCP.", 503);
      }
      const now = new Date().toISOString();
      const hits = await runtime.retrieval.search(ctx, { projectId, query: proposalId, limit: 20 });
      const existing = hits.find((h) => h.item.id === proposalId)?.item;
      const updatedItem: KnowledgeItem = {
        id: existing?.id ?? proposalId,
        tenantId: ctx.tenantId,
        projectId,
        domainId: existing?.domainId ?? 2,
        type: existing?.type ?? "business_rule",
        title: title?.trim() || existing?.title || proposalId,
        content,
        status: "draft",
        sourceId: existing?.sourceId ?? `mcp:${ctx.actorId}`,
        sourceOrigin: existing?.sourceOrigin ?? "internal",
        sourceKind: existing?.sourceKind ?? "agent",
        sourceVersion: existing?.sourceVersion ?? "mcp-rev",
        sourceUri: existing?.sourceUri ?? `.brain/proposals/${proposalId}.md`,
        version: (existing?.version ?? 1) + 1,
        contentHash: createHash("sha256").update(content).digest("hex"),
        confidence: existing?.confidence ?? 0.9,
        trustLevel: existing?.trustLevel ?? "self_authored",
        isInferred: false,
        tags: existing?.tags ?? [],
        relatedIds: existing?.relatedIds ?? [],
        accessPolicyId: existing?.accessPolicyId ?? auditPolicyId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const revised = await runtime.approvals.revise(ctx, projectId, proposalId, updatedItem);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "proposal_revision",
        targetId: proposalId,
        metadata: { title }
      });
      return okJson(revised);
    }
  );

  server.tool(
    "brain_memory_recall",
    describeMcpTool(profile, "Consulta diretamente as camadas de memória (working, episodic, semantic, procedural, organizational)."),
    {
      projectId: z.string().min(1),
      layer: z.enum(["working", "episodic", "semantic", "procedural", "organizational"]).optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    async ({ projectId, layer, limit }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.memory) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Gerenciador de memória SQL indisponível neste runtime MCP.", 503);
      }
      const entries = await runtime.memory.listVisible(ctx, projectId, layer);
      return okJson({ projectId, count: entries.length, entries: entries.slice(0, limit ?? 30) });
    }
  );

  server.tool(
    "brain_context_feedback",
    describeMcpTool(profile, "Registra feedback explícito de utilidade dos itens de um Context Pack para Context Hit Rate e CO_ACCESSED_WITH."),
    {
      projectId: z.string().min(1),
      sessionId: z.string().min(1),
      taskId: z.string().optional(),
      usefulItemIds: z.array(z.string()).default([]),
      editedPaths: z.array(z.string()).default([])
    },
    async ({ projectId, sessionId, taskId, usefulItemIds, editedPaths }) => {
      assertProjectAccess(ctx, projectId);
      for (const itemId of usefulItemIds) {
        runtime.retrieval.recordHitBoost(projectId, itemId, 0.25);
      }
      if (runtime.opRepo && editedPaths.length > 0) {
        const hitRate = await runtime.opRepo.recordContextEdits(ctx, projectId, sessionId, taskId ?? sessionId, editedPaths);
        return okJson({ recorded: true, projectId, sessionId, hitRate });
      }
      if (runtime.opRepo) {
        const hitRate = await runtime.opRepo.getContextHitRate(ctx, projectId, sessionId);
        return okJson({ recorded: true, projectId, sessionId, hitRate });
      }
      return okJson({ recorded: true, projectId, sessionId, usefulItemIds });
    }
  );
}

