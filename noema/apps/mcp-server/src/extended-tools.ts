import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_SYSTEM_PERMISSIONS,
  assertPermission,
  assertPolicyAccess,
  assertProjectAccess,
  PERMISSION_CATALOG,
  type AuthContext,
  type SystemPermission
} from "@noema/auth";
import { BrainError, type KnowledgeItem } from "@noema/core";
import {
  buildIncidentToCodeMap,
  evaluatePreDeployReadiness
} from "@noema/enterprise-views";
import { scanForSecrets } from "@noema/ingestion";
import { parseKnowledgeFile } from "@noema/knowledge";
import { computeProjectHealthReport } from "@noema/knowledge-health";
import { planAutonomousTasks } from "@noema/task-engine";
import { TemporalKnowledgeEngine } from "@noema/temporal-knowledge";
import { suggestLivingDocUpdates } from "@noema/workflow-orchestrator";
import type { NoemaRuntime } from "./index.js";
import { describeMcpTool, type McpConnectionProfileName } from "./connection-profile.js";

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerExtendedMcpTools(
  server: McpServer,
  runtime: NoemaRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  // 1. Conhecimento, Ingestão e Temporalidade
  server.tool(
    "brain_ingest_knowledge",
    describeMcpTool(profile, "Ingere arquivo ou snippet de conhecimento (Markdown/YAML) com scan de segredos e persistência SQL/retrieval."),
    {
      projectId: z.string().min(1),
      filePath: z.string().min(1),
      content: z.string().min(1),
      accessPolicyId: z.string().optional()
    },
    async ({ projectId, filePath, content, accessPolicyId }) => {
      assertProjectAccess(ctx, projectId);
      const scan = scanForSecrets(content, { useGitleaks: process.env.NOEMA_DISABLE_GITLEAKS !== "1" });
      if (!scan.clean) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Ingestão bloqueada por segredos detectados: ${scan.findings.join(", ")}`, 400);
      }
      const parsed = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId,
        filePath,
        rawContent: content
      });
      const resolvedPolicy = accessPolicyId ?? parsed.accessPolicyId ?? auditPolicyId;
      assertPolicyAccess(ctx, resolvedPolicy);
      const item: KnowledgeItem = { ...parsed, accessPolicyId: resolvedPolicy };
      if (runtime.knowledge?.upsertItem) {
        await runtime.knowledge.upsertItem(ctx, item);
      }
      if (runtime.retrieval.upsertItem) {
        await runtime.retrieval.upsertItem(item);
      }
      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: resolvedPolicy,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { filePath, type: item.type }
      });
      return okJson({ ingested: true, item: { id: item.id, title: item.title, type: item.type, status: item.status, accessPolicyId: resolvedPolicy } });
    }
  );

  server.tool(
    "brain_ingest_document",
    describeMcpTool(profile, "Extrai texto de documento (PDF/DOCX/TXT via AI Worker) com scan de segredos e persiste como conhecimento."),
    {
      projectId: z.string().min(1),
      filename: z.string().min(1),
      contentBase64: z.string().min(1),
      accessPolicyId: z.string().optional()
    },
    async ({ projectId, filename, contentBase64, accessPolicyId }) => {
      assertProjectAccess(ctx, projectId);
      const resolvedPolicy = accessPolicyId ?? auditPolicyId;
      assertPolicyAccess(ctx, resolvedPolicy);
      const rawBuffer = Buffer.from(contentBase64, "base64");
      let extractedMarkdown = "";
      const aiWorkerUrl = process.env.AI_WORKER_URL;
      if (aiWorkerUrl) {
        const res = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/parse-document`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename, content_base64: contentBase64 })
        });
        if (!res.ok) {
          throw new BrainError("BRAIN_ERR_CONFLICT", `AI Worker /parse-document retornou HTTP ${res.status}`, 502);
        }
        const parsed = (await res.json()) as { markdown?: string };
        extractedMarkdown = parsed.markdown ?? "";
      } else if (/\.(md|txt|ya?ml|json)$/i.test(filename)) {
        extractedMarkdown = rawBuffer.toString("utf8");
      } else {
        throw new BrainError("BRAIN_ERR_CONFLICT", "AI_WORKER_URL é necessário para converter documentos binários (PDF/DOCX).", 400);
      }

      const scan = scanForSecrets(extractedMarkdown, { useGitleaks: process.env.NOEMA_DISABLE_GITLEAKS !== "1" });
      if (!scan.clean) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Documento bloqueado por segredos detectados: ${scan.findings.join(", ")}`, 400);
      }
      const now = new Date().toISOString();
      const id = `DOC-${randomUUID().slice(0, 8)}`;
      const item: KnowledgeItem = {
        id,
        tenantId: ctx.tenantId,
        projectId,
        domainId: 2,
        type: "document",
        title: filename,
        content: extractedMarkdown,
        status: "draft",
        sourceId: `mcp-doc:${ctx.actorId}`,
        sourceOrigin: "internal",
        sourceKind: "agent",
        sourceVersion: "doc-1",
        sourceUri: `.brain/documents/${filename}`,
        version: 1,
        contentHash: createHash("sha256").update(extractedMarkdown).digest("hex"),
        confidence: 0.9,
        trustLevel: "self_authored",
        isInferred: false,
        tags: ["document-ingest"],
        relatedIds: [],
        accessPolicyId: resolvedPolicy,
        createdAt: now,
        updatedAt: now
      };
      if (runtime.knowledge?.upsertItem) {
        await runtime.knowledge.upsertItem(ctx, item);
      }
      if (runtime.retrieval.upsertItem) {
        await runtime.retrieval.upsertItem(item);
      }
      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: resolvedPolicy,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "document_ingest",
        targetId: id,
        metadata: { filename }
      });
      return okJson({ ingested: true, itemId: id, filename, chars: extractedMarkdown.length });
    }
  );

  server.tool(
    "brain_knowledge_diff",
    describeMcpTool(profile, "Compara duas versões (fromVersion vs toVersion) de um item de conhecimento."),
    {
      projectId: z.string().min(1),
      itemId: z.string().min(1),
      fromVersion: z.number().int().positive(),
      toVersion: z.number().int().positive()
    },
    async ({ projectId, itemId, fromVersion, toVersion }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.knowledge?.listVersions) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Histórico de versões indisponível neste runtime.", 503);
      }
      const versions = await runtime.knowledge.listVersions(ctx, projectId, itemId);
      const before = versions.find((v) => v.version === fromVersion);
      const after = versions.find((v) => v.version === toVersion);
      if (!before || !after) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Versão ${fromVersion} ou ${toVersion} não encontrada para '${itemId}'.`, 404);
      }
      const beforeLines = before.content.split(/\r?\n/);
      const afterLines = after.content.split(/\r?\n/);
      const beforeSet = new Set(beforeLines);
      const afterSet = new Set(afterLines);
      return okJson({
        projectId,
        itemId,
        fromVersion,
        toVersion,
        titleChanged: before.title !== after.title,
        statusChanged: before.status !== after.status,
        addedLines: afterLines.filter((l) => !beforeSet.has(l)),
        removedLines: beforeLines.filter((l) => !afterSet.has(l))
      });
    }
  );

  server.tool(
    "brain_temporal_query",
    describeMcpTool(profile, "Consulta o estado do conhecimento válido em uma data ISO-8601 UTC (Project Time Machine)."),
    {
      projectId: z.string().min(1),
      atDate: z.string().min(1),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    async ({ projectId, atDate, query, limit }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, {
        projectId,
        query: query ?? "",
        atDate,
        limit: limit ?? 25
      });
      const temporal = new TemporalKnowledgeEngine();
      for (const hit of hits) temporal.recordVersion(hit.item);
      const snapshot = temporal.queryAt(ctx, { projectId, atTimestamp: atDate });
      return okJson({
        projectId,
        atDate,
        count: snapshot.length,
        items: snapshot.map((item) => ({
          id: item.id,
          title: item.title,
          type: item.type,
          status: item.status,
          version: item.version,
          validFrom: item.validFrom ?? item.createdAt,
          validUntil: item.validUntil
        }))
      });
    }
  );

  server.tool(
    "brain_knowledge_health",
    describeMcpTool(profile, "Retorna relatório de saúde do projeto (regras sem cobertura VERIFIED_BY, itens >90d, conflitos)."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 300 });
      const items = hits.map((h) => h.item);
      const report = computeProjectHealthReport(items, []);
      return okJson({ projectId, totalItems: items.length, report });
    }
  );

  server.tool(
    "brain_living_docs_suggest",
    describeMcpTool(profile, "Sugere quais ADRs, contratos ou docs vivos devem ser revisados dado um conjunto de arquivos alterados."),
    {
      projectId: z.string().min(1),
      changedFiles: z.array(z.string().min(1)).min(1)
    },
    async ({ projectId, changedFiles }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 300 });
      const suggestions = suggestLivingDocUpdates(changedFiles, hits.map((h) => h.item));
      return okJson({ projectId, changedFiles, suggestions });
    }
  );

  // 2. Planejamento, Continuidade e Coordenação Multi-Agente
  server.tool(
    "brain_plan_tasks",
    describeMcpTool(profile, "Quebra uma feature ou épico em histórias e tarefas ordenadas por prioridade e dependências."),
    {
      projectId: z.string().min(1),
      epicDescription: z.string().min(1),
      targetFiles: z.array(z.string()).optional(),
      impactedRuleIds: z.array(z.string()).optional()
    },
    async ({ projectId, epicDescription, targetFiles, impactedRuleIds }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", domains: [2], limit: 200 });
      const tasks = planAutonomousTasks(epicDescription, hits.map((h) => h.item), {
        targetFiles,
        impactedRuleIds
      });
      return okJson({ projectId, count: tasks.length, tasks });
    }
  );

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

  // 3. Arquitetura, Cross-Service e Segurança
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

  // 4. Revisão, Memória e Feedback de Contexto
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

  server.tool(
    "brain_list_user_policies",
    describeMcpTool(profile, "Lista políticas granulares por usuário e os agentes vinculados que herdam permissões do usuário."),
    {
      projectId: z.string().min(1)
    },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para listar políticas de usuário.", 503);
      }
      const policies = await runtime.opRepo.listUserFineGrainedPolicies(ctx, projectId);
      return okJson({ projectId, policies });
    }
  );

  server.tool(
    "brain_upsert_user_policy",
    describeMcpTool(profile, "Cria ou atualiza via MCP uma política granular por usuário (papéis, ações, políticas, domínios, prefixos e agentes vinculados que herdam tudo que o usuário pode fazer)."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1),
      linkedAgentIds: z.array(z.string()).default([]),
      inheritUserPermissions: z.boolean().default(true),
      roles: z.array(z.string()).default(["developer", "tech-lead"]),
      allowedActions: z
        .array(z.enum(["read", "write", "create", "update", "approve", "manage_policies"]))
        .default(["read", "write", "create", "update", "approve", "manage_policies"]),
      allowedPolicies: z.array(z.string()).default(["public-org", "internal-project"]),
      allowedDomains: z.array(z.number().int().positive()).default([]),
      allowedPathPrefixes: z.array(z.string()).default([])
    },
    async ({
      projectId,
      userId,
      linkedAgentIds,
      inheritUserPermissions,
      roles,
      allowedActions,
      allowedPolicies,
      allowedDomains,
      allowedPathPrefixes
    }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para salvar política de usuário.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      const canManage =
        effectiveCtx.roles.includes("admin") ||
        effectiveCtx.roles.includes("tech-lead") ||
        effectiveCtx.roles.includes("appsec") ||
        effectiveCtx.allowedActions?.includes("manage_policies") ||
        effectiveCtx.inheritUserPermissions === true;
      if (!canManage) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Sem permissão para gerenciar políticas granulares de usuário.", 403);
      }
      const saved = await runtime.opRepo.upsertUserFineGrainedPolicy(effectiveCtx, projectId, {
        userId,
        linkedAgentIds,
        inheritUserPermissions,
        roles,
        allowedActions,
        allowedPolicies,
        allowedDomains,
        allowedPathPrefixes
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "user_policy",
        targetId: saved.userId,
        metadata: { linkedAgentIds: saved.linkedAgentIds, inheritUserPermissions: saved.inheritUserPermissions }
      });
      return okJson({ saved: true, projectId, policy: saved });
    }
  );

  server.tool(
    "brain_delete_user_policy",
    describeMcpTool(profile, "Remove uma política granular de usuário e seus vínculos de delegação para agentes."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1)
    },
    async ({ projectId, userId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para remover política de usuário.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      const deleted = await runtime.opRepo.deleteUserFineGrainedPolicy(effectiveCtx, projectId, userId);
      if (deleted) {
        await runtime.audit.record({
          tenantId: effectiveCtx.tenantId,
          projectId,
          accessPolicyId: "internal-project",
          actorId: effectiveCtx.actorId,
          actorType: effectiveCtx.actorType,
          action: "update",
          targetType: "user_policy",
          targetId: userId,
          metadata: { deleted: true }
        });
      }
      return okJson({ deleted, projectId, userId });
    }
  );

  const systemPermSchema = z.enum(ALL_SYSTEM_PERMISSIONS as [SystemPermission, ...SystemPermission[]]);

  server.tool(
    "brain_list_permissions_catalog",
    describeMcpTool(profile, "Lista todas as permissões disponíveis do sistema agrupadas por módulo (menus, conhecimento, propostas, runner, operação, cargos e permissões)."),
    {},
    async () => okJson({ permissions: PERMISSION_CATALOG })
  );

  server.tool(
    "brain_list_roles",
    describeMcpTool(profile, "Lista todos os cargos (padrão e customizados) e suas permissões e políticas associadas."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:view");
      const [roles, assignments] = await Promise.all([
        runtime.opRepo.listRoles(effectiveCtx, projectId),
        runtime.opRepo.listUserRoleAssignments(effectiveCtx, projectId)
      ]);
      return okJson({ projectId, roles, assignments });
    }
  );

  server.tool(
    "brain_upsert_role",
    describeMcpTool(profile, "Cria ou atualiza um cargo com permissões variadas de menus, funções e políticas."),
    {
      projectId: z.string().min(1),
      roleId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().default(""),
      permissions: z.array(systemPermSchema),
      allowedPolicies: z.array(z.string()).default(["public-org", "internal-project"])
    },
    async ({ projectId, roleId, name, description, permissions, allowedPolicies }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:manage");
      const role = await runtime.opRepo.upsertRole(effectiveCtx, projectId, {
        roleId,
        name,
        description,
        permissions,
        allowedPolicies
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "role",
        targetId: role.roleId,
        metadata: { permissionsCount: role.permissions.length }
      });
      return okJson({ saved: true, projectId, role });
    }
  );

  server.tool(
    "brain_delete_role",
    describeMcpTool(profile, "Remove um cargo customizado do projeto."),
    { projectId: z.string().min(1), roleId: z.string().min(1) },
    async ({ projectId, roleId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:manage");
      const deleted = await runtime.opRepo.deleteRole(effectiveCtx, projectId, roleId);
      return okJson({ deleted, projectId, roleId });
    }
  );

  server.tool(
    "brain_assign_user_roles",
    describeMcpTool(profile, "Atribui cargos a um usuário e vincula agentes que herdam integralmente todas as permissões do usuário (sem separação humano/IA)."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1),
      roleIds: z.array(z.string()).default(["developer"]),
      linkedAgentIds: z.array(z.string()).default([]),
      inheritUserPermissions: z.boolean().default(true),
      extraPermissions: z.array(systemPermSchema).default([]),
      deniedPermissions: z.array(systemPermSchema).default([]),
      allowedDomains: z.array(z.number().int().positive()).default([])
    },
    async ({
      projectId,
      userId,
      roleIds,
      linkedAgentIds,
      inheritUserPermissions,
      extraPermissions,
      deniedPermissions,
      allowedDomains
    }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "users:assign_roles");
      const assignment = await runtime.opRepo.upsertUserRoleAssignment(effectiveCtx, projectId, {
        userId,
        roleIds,
        linkedAgentIds,
        inheritUserPermissions,
        extraPermissions,
        deniedPermissions,
        allowedDomains
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "user_role_assignment",
        targetId: assignment.userId,
        metadata: { roleIds: assignment.roleIds, linkedAgentIds: assignment.linkedAgentIds, inheritUserPermissions: assignment.inheritUserPermissions }
      });
      return okJson({ saved: true, projectId, assignment });
    }
  );
}
