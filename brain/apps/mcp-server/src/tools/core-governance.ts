import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateArchitectureChange, type ArchitectureImportEdge } from "@brain/architecture-guardian";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { evaluateBusinessRuleCompliance } from "@brain/business-rule-guardian";
import { extractFileDependencies } from "@brain/code-intelligence";
import { BrainError } from "@brain/core";
import { analyzeDistributedImpact } from "@brain/impact-analysis";
import { parseKnowledgeFile } from "@brain/knowledge";
import { findChangedWorkspaceSources } from "@brain/workspace-detection";
import { describeMcpTool, type McpConnectionProfileName } from "../connection-profile.js";
import { configuredProjectWorkspaceRoots, okJson, resolveWorkspaceFile } from "../helpers.js";
import type { BrainRuntime } from "../runtime.js";

export function registerCoreGovernanceTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
) {
  server.tool(
    "brain_analyze_change_impact",
    describeMcpTool(profile, "Calcula impactos confirmados vs. hipóteses antes de alterar código ou regras."),
    { projectId: z.string(), targetIds: z.array(z.string()).min(1), limit: z.number().optional() },
    async ({ projectId, targetIds, limit }) => {
      assertProjectAccess(ctx, projectId);
      const ruleHits = await runtime.retrieval.search(ctx, { projectId, query: "business_rule", domains: [2], limit: 100 });
      const report = await analyzeDistributedImpact(ctx, runtime.graph, projectId, targetIds, 2, {
        rules: ruleHits.map((hit) => hit.item),
        ...(runtime.crossServiceRegistry ? { crossServiceRegistry: runtime.crossServiceRegistry } : {})
      });
      const bounded = (items: typeof report.confirmedImpacts) => limit ? items.slice(0, limit) : items;
      return okJson({
        ...report,
        confirmedImpacts: bounded(report.confirmedImpacts),
        hypotheses: bounded(report.hypotheses),
        directImpacts: bounded(report.directImpacts),
        transitiveImpacts: bounded(report.transitiveImpacts)
      });
    }
  );

  server.tool(
    "brain_validate_implementation",
    describeMcpTool(profile, "Valida um conjunto de arquivos/diff contra regras e decisões conhecidas."),
    {
      projectId: z.string(),
      paths: z.array(z.string()).optional(),
      diffOrPaths: z.array(z.string()).optional(),
      mode: z.enum(["audit", "advisory", "enforced"]).optional(),
      limit: z.number().optional()
    },
    async ({ projectId, paths, diffOrPaths, mode, limit }) => {
      assertProjectAccess(ctx, projectId);
      const effectiveMode = mode ?? "advisory";
      const targetPaths = diffOrPaths ?? paths ?? [];
      if (targetPaths.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe ao menos um caminho em diffOrPaths ou paths.", 400);
      }
      const workspaceRoot = runtime.workspaceRoots?.[projectId]
        ?? configuredProjectWorkspaceRoots()[projectId]
        ?? runtime.workspaceRoot
        ?? process.env.BRAIN_WORKSPACE_ROOT
        ?? process.cwd();
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", domains: [2, 3], limit: 100 });
      const activeRules = hits.map((h) => h.item);
      const files = targetPaths.map((path) => {
        const safePath = resolveWorkspaceFile(workspaceRoot, path);
        return { path, content: existsSync(safePath) ? readFileSync(safePath, "utf8") : "" };
      });
      const imports: ArchitectureImportEdge[] = [];
      for (const file of files) {
        if (!file.content) continue;
        const deps = extractFileDependencies(file.path, file.content);
        const pkgMatch = file.path.replace(/\\/g, "/").match(/(?:^|\/)(packages|apps)\/([^/]+)\//);
        const fromPkg = pkgMatch ? (pkgMatch[1] === "apps" ? `apps/${pkgMatch[2]}` : pkgMatch[2]!) : "apps/unknown";
        for (const dep of deps) {
          if (dep.startsWith("@brain/")) {
            imports.push({ fromPkg, toPkg: dep, filePath: file.path });
          }
        }
      }
      const brReport = evaluateBusinessRuleCompliance({
        mode: effectiveMode,
        files,
        activeRules
      });
      const archReport = evaluateArchitectureChange({
        mode: effectiveMode,
        imports
      });
      const allViolations = [...archReport.violations, ...brReport.violations];
      const violations = limit ? allViolations.slice(0, limit) : allViolations;
      return okJson({
        projectId,
        mode: effectiveMode,
        passed: archReport.passed && brReport.passed,
        checkedPaths: targetPaths,
        checkedRules: brReport.checkedRules,
        checkedImports: imports.length,
        violations
      });
    }
  );

  server.tool(
    "brain_create_handoff",
    describeMcpTool(profile, "Salva checkpoint validado (branch, commit, arquivos, testes, próximos passos) para outra IDE."),
    {
      projectId: z.string(),
      taskId: z.string(),
      plan: z.string().optional(),
      fromAgent: z.string().optional(),
      repoUrl: z.string().optional(),
      branch: z.string().optional(),
      baseCommitSha: z.string().optional(),
      modifiedFiles: z.array(z.string()).optional(),
      nextSteps: z.array(z.string()),
      workingTreeDirty: z.boolean().optional(),
      testsExecuted: z.array(z.string()).optional(),
      decisions: z.array(z.string()).optional()
    },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      const decisions = input.decisions ?? (input.plan ? [input.plan] : []);
      const ho = runtime.handoffs.createHandoff(ctx, {
        projectId: input.projectId,
        taskId: input.taskId,
        fromAgent: input.fromAgent ?? ctx.actorId,
        repoUrl: input.repoUrl ?? ".",
        branch: input.branch ?? "main",
        baseCommitSha: input.baseCommitSha ?? "HEAD",
        modifiedFiles: input.modifiedFiles ?? [],
        nextSteps: input.nextSteps,
        workingTreeDirty: input.workingTreeDirty ?? false,
        testsExecuted: input.testsExecuted ?? [],
        decisions
      });
      if (runtime.opRepo) {
        await runtime.opRepo.saveHandoff(ctx, ho);
        await runtime.opRepo.upsertLease(ctx, ho.projectId, ho.taskId, ho.branch);
      }
      return okJson(ho);
    }
  );

  server.tool(
    "brain_resume_handoff",
    describeMcpTool(profile, "Retoma tarefa iniciada em outra IDE verificando divergências de branch/commit e leases."),
    { projectId: z.string(), handoffId: z.string().optional(), taskId: z.string().optional(), currentBranch: z.string().optional(), currentCommitSha: z.string().optional() },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      if (Boolean(input.handoffId) === Boolean(input.taskId)) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Informe exatamente um entre handoffId e taskId.", 400);
      }
      const mem = runtime.handoffs.resumeHandoff(ctx, input);
      if (!mem.handoff && runtime.opRepo) {
        const persisted = input.handoffId
          ? await runtime.opRepo.getHandoffById?.(ctx, input.projectId, input.handoffId)
          : await runtime.opRepo.getLatestHandoff(ctx, input.projectId, input.taskId);
        if (persisted) {
          const warnings: string[] = [];
          if (input.currentBranch && input.currentBranch !== persisted.branch) {
            warnings.push(`Divergência de branch: esperado '${persisted.branch}', atual '${input.currentBranch}'.`);
          }
          if (input.currentCommitSha && input.currentCommitSha !== persisted.baseCommitSha) {
            warnings.push(`Divergência de commit: esperado '${persisted.baseCommitSha}', atual '${input.currentCommitSha}'.`);
          }
          if (persisted.workingTreeDirty) {
            warnings.push("Handoff anterior foi salvo com working tree dirty.");
          }
          const lease = await runtime.opRepo.getTaskLease?.(ctx, input.projectId, persisted.taskId);
          if (lease && (lease.actorId !== ctx.actorId || (input.currentBranch && lease.branch !== input.currentBranch))) {
            warnings.push(`Task Lease ativo por '${lease.actorId}' na branch '${lease.branch}'.`);
          }
          return okJson({ handoff: persisted, warnings });
        }
      }
      const warnings = [...mem.warnings];
      if (input.currentCommitSha && mem.handoff && input.currentCommitSha !== mem.handoff.baseCommitSha) {
        warnings.push(`Divergência de commit: esperado '${mem.handoff.baseCommitSha}', atual '${input.currentCommitSha}'.`);
      }
      return okJson({ ...mem, warnings });
    }
  );

  server.tool(
    "brain_record_learning",
    describeMcpTool(profile, "Registra memória episódica e feedback de utilidade (Context Hit Rate)."),
    {
      projectId: z.string(),
      summary: z.string(),
      usedItemIds: z.array(z.string()).optional(),
      sessionId: z.string().min(1).max(128).optional(),
      taskId: z.string().optional(),
      editedPaths: z.array(z.string()).optional(),
      missingPaths: z.array(z.string()).optional()
    },
    async ({ projectId, summary, usedItemIds, sessionId, taskId, editedPaths, missingPaths }) => {
      assertProjectAccess(ctx, projectId);
      const uniqueUsedItemIds = [...new Set(usedItemIds ?? [])];
      let hitRateUpdated = 0;
      let hitRate = null;
      const evidenceWarnings: string[] = [];
      if ((uniqueUsedItemIds.length > 0 || (editedPaths?.length ?? 0) > 0 || Boolean(taskId)) && (!sessionId || !runtime.opRepo)) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId e persistência de sessão são necessários para registrar evidência.", 400);
      if (uniqueUsedItemIds.length > 0 && sessionId && runtime.opRepo) {
        const result = await runtime.opRepo.recordContextEvidence(ctx, projectId, sessionId, uniqueUsedItemIds, "citation");
        hitRateUpdated = result.newlyHit.length;
        hitRate = result.rate;
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      } else if (runtime.knowledge?.incrementHitCounts) {
        for (const id of uniqueUsedItemIds) {
          const item = await runtime.retrieval.getItem(ctx, projectId, id);
          if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Item '${id}' não encontrado ou sem permissão.`, 404);
        }
        const updated = await runtime.knowledge.incrementHitCounts(ctx, projectId, uniqueUsedItemIds);
        hitRateUpdated = updated.length;
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      } else {
        for (const id of uniqueUsedItemIds) runtime.retrieval.recordHitBoost(projectId, id);
        hitRateUpdated = uniqueUsedItemIds.length;
      }
      if (taskId || (editedPaths?.length ?? 0) > 0) {
        if (!sessionId || !taskId || !runtime.opRepo) throw new BrainError("BRAIN_ERR_INVALID_INPUT", "sessionId, taskId e lease ativo são necessários para evidência de edição.", 400);
        const lease = await runtime.opRepo.getTaskLease(ctx, projectId, taskId);
        if (!lease || lease.actorId !== ctx.actorId) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Evidência de edição requer lease ativo do ator autenticado.", 403);
        const candidates = await runtime.opRepo.getContextEditCandidates(ctx, projectId, sessionId, taskId);
        const workspaceRoot = runtime.workspaceRoots?.[projectId] ?? runtime.workspaceRoot ?? process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd();
        const changedSources = await findChangedWorkspaceSources(workspaceRoot, candidates);
        const requested = editedPaths?.map((path) => path.trim().replace(/\\/g, "/")).filter(Boolean);
        const requestedSet = requested ? new Set(requested) : undefined;
        const confirmedPaths = requestedSet ? changedSources.filter((path) => requestedSet.has(path)) : changedSources;
        const edited = await runtime.opRepo.recordContextEdits(ctx, projectId, sessionId, taskId, confirmedPaths);
        hitRate = edited.rate;
        hitRateUpdated += edited.newlyHit.length;
        const candidatePaths = new Set(candidates.map((candidate) => candidate.sourceUri));
        if (candidates.length === 0) evidenceWarnings.push("Nenhuma fonte local com hash de baseline foi entregue nesta sessão e tarefa; evidência automática de diff indisponível.");
        else if (!requested && changedSources.length === 0) evidenceWarnings.push("Nenhuma fonte local entregue mudou desde a montagem do Context Pack.");
        for (const path of requested ?? []) {
          if (!candidatePaths.has(path)) evidenceWarnings.push(`O caminho '${path}' não tem hash de baseline para esta sessão e tarefa.`);
          else if (!changedSources.includes(path)) evidenceWarnings.push(`O caminho '${path}' não mudou desde a entrega do Context Pack.`);
        }
        runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      }
      if (runtime.opRepo) {
        await runtime.opRepo.appendMemory(ctx, {
          projectId,
          layer: "episodic",
          content: summary,
          accessPolicyId: auditPolicyId
        });
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId, projectId, accessPolicyId: auditPolicyId, actorId: ctx.actorId, actorType: ctx.actorType,
        action: "create", targetType: "memory", metadata: { summary, usedItemIds: uniqueUsedItemIds, missingPaths }
      });
      return okJson({ recorded: true, hitRateUpdated, hitRate, warnings: evidenceWarnings });
    }
  );

  server.tool(
    "brain_change_propose",
    describeMcpTool(profile, "Submete proposta formal em status draft (com suporte a camada, formato de diagrama/topologia e tags)."),
    {
      projectId: z.string(),
      title: z.string().min(1),
      content: z.string().min(1),
      targetType: z.string().optional(),
      layer: z.enum(["architecture", "business", "code", "product", "operations", "general"]).optional(),
      format: z.enum(["markdown", "mermaid", "topology", "flow", "code"]).optional(),
      tags: z.array(z.string()).optional()
    },
    async ({ projectId, title, content, targetType, layer, format, tags }) => {
      assertProjectAccess(ctx, projectId);
      const proposalId = `PROP-${randomUUID()}`;
      const typeVal = targetType ?? "business_rule";
      const filePath = `.brain/01-business/${proposalId}.md`;
      const mergedTags = [
        ...(tags ?? []),
        ...(layer ? [`layer:${layer}`] : []),
        ...(format ? [`format:${format}`] : [])
      ];
      const tagsLine = mergedTags.length > 0 ? `\ntags: [${mergedTags.join(", ")}]` : "";
      const rawContent = `---\nid: ${proposalId}\ntitle: ${title}\ntype: ${typeVal}\nstatus: draft\naccess_policy: ${auditPolicyId}${tagsLine}\n---\n\n${content}`;
      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId,
        filePath,
        rawContent
      });
      if (runtime.knowledge?.upsertItem) {
        await runtime.knowledge.upsertItem(ctx, item);
      } else if (typeof runtime.retrieval.upsertItem === "function") {
        await runtime.retrieval.upsertItem(item);
      }
      if (runtime.approvals) {
        await runtime.approvals.submit(ctx, item);
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId, projectId, accessPolicyId: auditPolicyId, actorId: ctx.actorId, actorType: ctx.actorType,
        action: "create", targetType: "proposal", targetId: proposalId, metadata: { title, targetType: typeVal }
      });
      return okJson({ proposalId, status: "draft", projectId, title, sourceUri: filePath });
    }
  );

  server.tool(
    "brain_change_decide",
    describeMcpTool(profile, "Registra decisão autorizada sobre uma proposta (humanos autorizados ou agentes vinculados a usuário com herança de permissões)."),
    {
      projectId: z.string(),
      proposalId: z.string().min(1),
      decision: z.enum(["approve", "reject", "request_changes"]),
      note: z.string().optional()
    },
    async ({ projectId, proposalId, decision, note }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.approvals) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Fila de aprovação indisponível neste runtime MCP.", 503);
      }
      const effectiveCtx = runtime.opRepo
        ? await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId)
        : ctx;
      const decided = await runtime.approvals.decide(effectiveCtx, projectId, proposalId, decision, note);
      if (decision === "approve") {
        if (runtime.knowledge?.upsertItem) {
          await runtime.knowledge.upsertItem(ctx, decided.item);
        } else if (typeof runtime.retrieval.upsertItem === "function") {
          await runtime.retrieval.upsertItem(decided.item);
        }
      }
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: decided.item.accessPolicyId ?? auditPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: decision === "approve" ? "approve" : "update",
        targetType: "proposal",
        targetId: proposalId,
        metadata: { decision, status: decided.status, ...(note ? { note } : {}) }
      });
      return okJson({
        proposalId: decided.proposalId,
        projectId: decided.projectId,
        status: decided.status,
        itemStatus: decided.item.status,
        reviewedBy: decided.reviewedBy,
        ...(decided.reviewNote ? { reviewNote: decided.reviewNote } : {})
      });
    }
  );

  server.tool(
    "brain_delegate_task",
    describeMcpTool(profile, "Enfileira uma tarefa em background para o Brain Runner ou agenda execuções recorrentes via cron UTC."),
    {
      projectId: z.string(),
      instruction: z.string().min(1),
      cron: z.string().min(1).optional(),
      priority: z.enum(["low", "normal", "high"]).optional()
    },
    async (input) => {
      assertProjectAccess(ctx, input.projectId);
      if (input.cron) {
        if (!runtime.scheduleRunnerTask) {
          throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Agendamento cron requer DATABASE_URL e um scheduler pg-boss configurado.", 503);
        }
        const schedule = await runtime.scheduleRunnerTask({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          actorId: ctx.actorId,
          accessPolicyId: auditPolicyId,
          instruction: input.instruction,
          priority: input.priority ?? "normal",
          cron: input.cron
        });
        await runtime.audit.record({
          tenantId: ctx.tenantId, projectId: input.projectId, accessPolicyId: auditPolicyId,
          actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "runner_schedule",
          targetId: schedule.scheduleId, metadata: { cron: input.cron, priority: input.priority ?? "normal" }
        });
        return okJson({ ...schedule, status: "scheduled", cron: input.cron });
      }
      const task = runtime.runner.enqueue(ctx, input);
      if (runtime.opRepo) {
        await runtime.opRepo.saveRunnerTask(ctx, task);
      }
      return okJson({ ...task, ...(input.cron ? { cron: input.cron } : {}) });
    }
  );
}

