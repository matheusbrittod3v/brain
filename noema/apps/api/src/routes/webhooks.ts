import { createHash, createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BrainRunnerQueue } from "@noema/agent-runner";
import type { ApprovalDecision, ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AuditLogger } from "@noema/audit-engine";
import { assertPolicyAccess, assertProjectAccess, authenticateRequest, type AuthContext } from "@noema/auth";
import { parseGitHubPushEvent, verifyGitHubSignature } from "@noema/connector-github";
import {
  handleSaasWebhook,
  parseChannelActionPayload,
  verifyChannelWebhookSignature,
  verifySlackRequestSignature,
  type SaasProvider
} from "@noema/connector-saas";
import { BrainError, type KnowledgeItem } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import { scanForSecrets } from "@noema/ingestion";
import type { PostgresKnowledgeRepository } from "@noema/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { assertSecretScanClean, redactPiiWithAiWorker } from "../services/ai-worker.js";
import {
  configuredGitHubRepositories,
  enqueueRemoteGitIngestJob,
  mapExternalHumanActor,
  resolveGitHubRepoMapping
} from "../services/jobs.js";

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    opRepo?: PgOperationalRepository;
    pgKnowledge?: PostgresKnowledgeRepository;
    pgRetrieval?: PostgresRetrievalEngine;
    retrieval: HybridRetrievalEngine;
    pgApprovals?: PostgresApprovalQueue;
    approvals: ApprovalQueue;
    runner: BrainRunnerQueue;
    enqueueGitHubJob?: typeof enqueueRemoteGitIngestJob;
    githubMainHeadMemory: Map<string, { repository: string; commitSha: string; accessPolicyId: string }>;
    testExecutionMemory: Map<string, { testItemId: string; accessPolicyId: string; commitSha: string; repository?: string; status: "passed" | "failed" | "skipped"; durationMs: number | null; executedAt: string; receivedBy: string }>;
    integrationEventMemory: Map<string, { eventHash: string; response?: Record<string, unknown> }>;
  }
) {
  const {
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    opRepo,
    pgKnowledge,
    retrieval,
    pgApprovals,
    approvals,
    runner,
    enqueueGitHubJob = enqueueRemoteGitIngestJob,
    githubMainHeadMemory,
    testExecutionMemory,
    integrationEventMemory
  } = deps;

  app.post<{ Params: { provider: string }; Body: Record<string, unknown> }>(
    "/v1/ingestion/webhooks/:provider",
    async (req) => {
      const provider = req.params.provider.toLowerCase();
      if (provider === "github") {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
        if (!secret || !rawBody || !verifyGitHubSignature(rawBody, sig, secret)) {
          throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Assinatura GitHub Webhook inválida.", 401);
        }
        if ((req.headers["x-github-event"] as string | undefined) !== "push") {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Este webhook GitHub aceita somente eventos push.", 422);
        }
        const summary = parseGitHubPushEvent(req.body ?? {});
        const mapping = resolveGitHubRepoMapping(summary.repository);
        if (!mapping) throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Repositório ${summary.repository} não está mapeado para um projeto.`, 403);
        const repository = summary.repository.toLowerCase();
        const mainBranchPush = summary.ref === "refs/heads/main";
        const branch = summary.ref.slice("refs/heads/".length);
        const deletedRef = summary.commitSha === "0000000000000000000000000000000000000000";
        const beforeIsValid = /^[a-f0-9]{40}$/i.test(summary.beforeCommitSha) || summary.beforeCommitSha === "0000000000000000000000000000000000000000";
        if ((!deletedRef && !/^[a-f0-9]{40}$/i.test(summary.commitSha)) || !beforeIsValid || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(summary.ref)) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Payload push GitHub inválido ou sem commit/ref válido.", 422);
        }
        const auditContext: AuthContext = {
          tenantId: mapping.tenantId,
          actorId: "github-webhook",
          actorType: "system",
          roles: ["system"],
          allowedProjects: [mapping.projectId],
          allowedPolicies: [mapping.accessPolicyId]
        };
        let mainHeadUpdated = false;
        if (mainBranchPush) {
          if (deletedRef) {
            if (opRepo) {
              const deleted = await opRepo.deleteGitHubMainHead(auditContext, { projectId: mapping.projectId, repository, beforeCommitSha: summary.beforeCommitSha });
              mainHeadUpdated = deleted.length > 0;
            } else {
              const key = `${mapping.tenantId}:${mapping.projectId}:${repository}`;
              const existing = githubMainHeadMemory.get(key);
              mainHeadUpdated = Boolean(existing && existing.commitSha === summary.beforeCommitSha.toLowerCase());
              if (mainHeadUpdated) githubMainHeadMemory.delete(key);
            }
            return { accepted: true, provider: "github", deleted: true, repository: summary.repository, mainHeadUpdated };
          }
          if (opRepo) {
            const saved = await opRepo.upsertGitHubMainHead(auditContext, { projectId: mapping.projectId, repository, commitSha: summary.commitSha, accessPolicyId: mapping.accessPolicyId, beforeCommitSha: summary.beforeCommitSha });
            mainHeadUpdated = saved.length > 0;
          } else {
            const key = `${mapping.tenantId}:${mapping.projectId}:${repository}`;
            const existing = githubMainHeadMemory.get(key);
            if (!existing || existing.commitSha === summary.beforeCommitSha.toLowerCase()) {
              githubMainHeadMemory.set(key, { repository, commitSha: summary.commitSha.toLowerCase(), accessPolicyId: mapping.accessPolicyId });
              mainHeadUpdated = true;
            }
          }
          if (!mainHeadUpdated) {
            return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha, ignored: true, reason: "out_of_order_main_push", mainHeadUpdated: false };
          }
        } else if (opRepo) {
          if (deletedRef) {
            const deleted = await opRepo.deleteGitHubRefHead(auditContext, { projectId: mapping.projectId, repository, branch, beforeCommitSha: summary.beforeCommitSha });
            if (!deleted.length) return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, ignored: true, reason: "out_of_order_ref_delete" };
            return { accepted: true, provider: "github", deleted: true, repository: summary.repository, branch };
          }
          const saved = await opRepo.upsertGitHubRefHead(auditContext, { projectId: mapping.projectId, repository, branch, commitSha: summary.commitSha, accessPolicyId: mapping.accessPolicyId, beforeCommitSha: summary.beforeCommitSha });
          if (!saved.length) return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, ignored: true, reason: "out_of_order_ref_push" };
        } else if (deletedRef) {
          return { accepted: true, provider: "github", deleted: true, repository: summary.repository, mainHeadUpdated: false };
        }
        if (process.env.NOEMA_PG_BOSS !== "1") {
          throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Webhook GitHub exige o worker pg-boss ativo.", 503);
        }
        const [owner, repo] = summary.repository.split("/");
        const jobId = await enqueueGitHubJob({ ...mapping, owner: owner!, repo: repo!, ref: summary.commitSha, branch, beforeCommitSha: summary.beforeCommitSha });
        if (!jobId) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Banco de dados do worker não está configurado.", 503);
        await recordAudit(auditContext, {
          tenantId: mapping.tenantId,
          projectId: mapping.projectId,
          accessPolicyId: mapping.accessPolicyId,
          actorId: auditContext.actorId,
          actorType: auditContext.actorType,
          action: "create",
          targetType: "github_ingestion_job",
          targetId: jobId,
          metadata: { repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha }
        });
        return { accepted: true, provider: "github", repository: summary.repository, ref: summary.ref, commitSha: summary.commitSha, jobId, mainHeadUpdated };
      }
      const item = handleSaasWebhook(provider as SaasProvider, req.body ?? {});
      assertSecretScanClean(scanForSecrets(`${item.title}\n${item.content}`), "Segredo detectado no payload do webhook");
      const originalContent = item.content;
      const originalTitle = item.title;
      const [sanitizedContent, sanitizedTitle] = await Promise.all([redactPiiWithAiWorker(item.content), redactPiiWithAiWorker(item.title)]);
      item.content = sanitizedContent;
      item.title = sanitizedTitle;
      item.contentHash = createHash("sha256").update(`${sanitizedTitle}\n${sanitizedContent}`).digest("hex");
      await upsertKnowledgeItem(
        { tenantId: item.tenantId, actorId: "saas-webhook", actorType: "system", roles: ["system"], allowedProjects: [item.projectId], allowedPolicies: [item.accessPolicyId] },
        item
      );
      await recordAudit(
        { tenantId: item.tenantId, actorId: "saas-webhook", actorType: "system", roles: ["system"], allowedProjects: [item.projectId], allowedPolicies: [item.accessPolicyId] },
        {
          tenantId: item.tenantId,
          projectId: item.projectId,
          accessPolicyId: item.accessPolicyId,
          actorId: "saas-webhook",
          actorType: "system",
          action: "create",
          targetType: "knowledge_item",
          targetId: item.id,
          metadata: { source: "saas_webhook", piiRedacted: sanitizedContent !== originalContent || sanitizedTitle !== originalTitle }
        }
      );
      return { accepted: true, provider, itemId: item.id, trustLevel: item.trustLevel };
    }
  );

  app.post<{
    Params: { provider: string };
    Body: {
      eventType?: string;
      projectId?: string;
      proposalId?: string;
      approved?: boolean;
      decision?: ApprovalDecision;
      proposalVersion?: number;
      comment?: string;
      externalUserId?: string;
      externalEventId?: string;
      taskId?: string;
      questionId?: string;
      response?: string;
      idempotencyKey?: string;
      runId?: string;
      commitSha?: string;
      repository?: string;
      executedAt?: string;
      results?: Array<{ testItemId: string; status: string; durationMs?: number }>;
      payload?: Record<string, unknown>;
    };
  }>("/v1/integrations/:provider/events", async (req) => {
    const provider = req.params.provider.toLowerCase();
    const webhookSecret = process.env[`NOEMA_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sigHeader = (req.headers["x-noema-signature-256"] as string | undefined) ?? (req.headers["x-hub-signature-256"] as string | undefined);
      if (!verifyChannelWebhookSignature(JSON.stringify(req.body ?? {}), sigHeader, webhookSecret)) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Assinatura HMAC inválida para canal '${provider}'.`, 401);
      }
    }
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const body = req.body ?? {};
    if (body.eventType === "test.results") {
      if (!webhookSecret) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Resultados de CI '${provider}' requerem segredo HMAC configurado.`, 401);
      if (
        typeof body.projectId !== "string" ||
        typeof body.externalUserId !== "string" ||
        !body.externalUserId.trim() ||
        typeof body.runId !== "string" ||
        !body.runId.trim() ||
        typeof body.commitSha !== "string" ||
        !/^[0-9a-f]{40,64}$/i.test(body.commitSha) ||
        !Array.isArray(body.results) ||
        body.results.length < 1 ||
        body.results.length > 500
      ) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resultados CI requerem projectId, externalUserId, runId, commitSha (40–64 hex) e 1–500 resultados.", 400);
      }
      assertProjectAccess(ctx, body.projectId);
      const serviceActor = mapExternalHumanActor(ctx, provider, body.externalUserId, body.projectId, "internal-project", "system");
      if (!serviceActor.roles.includes("ci-bot")) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Identidade externa precisa do papel ci-bot.", 403);
      await enforceOpa(serviceActor, { projectId: body.projectId, accessPolicyId: "internal-project", action: "write" });
      const configuredRepositories = configuredGitHubRepositories(serviceActor.tenantId, body.projectId);
      let repository = typeof body.repository === "string" ? body.repository.trim().toLowerCase() : undefined;
      if (repository) {
        const repositoryMapping = resolveGitHubRepoMapping(repository);
        if (!repositoryMapping || repositoryMapping.tenantId !== serviceActor.tenantId || repositoryMapping.projectId !== body.projectId) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Repositório CI '${repository}' não está mapeado para este projeto.`, 403);
        }
      } else if (configuredRepositories.length === 1) repository = configuredRepositories[0];
      else if (configuredRepositories.length > 1) throw new BrainError("BRAIN_ERR_CONFLICT", "Resultados CI de um projeto com vários repositórios precisam informar 'repository'.", 400);

      const seen = new Set<string>();
      const normalized = [] as Array<{ testItemId: string; accessPolicyId: string; status: "passed" | "failed" | "skipped"; durationMs: number | null }>;
      for (const result of body.results as Array<Record<string, unknown>>) {
        if (
          !result ||
          typeof result.testItemId !== "string" ||
          !result.testItemId.trim() ||
          seen.has(result.testItemId) ||
          !["passed", "failed", "skipped"].includes(String(result.status)) ||
          (result.durationMs !== undefined && (!Number.isInteger(result.durationMs) || Number(result.durationMs) < 0))
        ) {
          throw new BrainError("BRAIN_ERR_CONFLICT", "Cada resultado deve ter testItemId único, status válido e durationMs inteiro não negativo.", 400);
        }
        seen.add(result.testItemId);
        const item = pgKnowledge ? await pgKnowledge.getItem(serviceActor, body.projectId, result.testItemId) : retrieval.getItem(serviceActor, body.projectId, result.testItemId);
        if (!item || (item.type !== "test" && !/\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(item.sourceUri))) {
          throw new BrainError("BRAIN_ERR_NOT_FOUND", `Arquivo de teste '${result.testItemId}' não encontrado.`, 404);
        }
        await enforceOpa(serviceActor, { projectId: body.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
        normalized.push({ testItemId: item.id, accessPolicyId: item.accessPolicyId, status: result.status as "passed" | "failed" | "skipped", durationMs: result.durationMs === undefined ? null : Number(result.durationMs) });
      }
      const executedAt = typeof body.executedAt === "string" && Number.isFinite(Date.parse(body.executedAt)) ? new Date(body.executedAt) : new Date();
      let acceptedCount = 0;
      let duplicateCount = 0;
      if (opRepo) {
        ({ acceptedCount, duplicateCount } = await opRepo.recordTestExecutionResults(serviceActor, { projectId: body.projectId, provider, runId: body.runId, commitSha: body.commitSha.toLowerCase(), repository, receivedBy: serviceActor.actorId, executedAt, results: normalized }));
      } else {
        for (const result of normalized) {
          const key = `${serviceActor.tenantId}:${body.projectId}:${provider}:${body.runId}:${result.testItemId}`;
          const value = { testItemId: result.testItemId, accessPolicyId: result.accessPolicyId, commitSha: body.commitSha.toLowerCase(), repository, status: result.status, durationMs: result.durationMs, executedAt: executedAt.toISOString(), receivedBy: serviceActor.actorId };
          const existing = testExecutionMemory.get(key);
          if (existing && (existing.repository !== value.repository || existing.commitSha !== value.commitSha || existing.status !== value.status || existing.durationMs !== value.durationMs)) {
            throw new BrainError("BRAIN_ERR_CONFLICT", `Execução '${body.runId}' já foi registrada com resultado diferente para '${result.testItemId}'.`, 409);
          }
          if (existing) duplicateCount++;
          else {
            testExecutionMemory.set(key, value);
            acceptedCount++;
          }
        }
      }
      if (acceptedCount) {
        await recordAudit(serviceActor, { tenantId: serviceActor.tenantId, projectId: body.projectId, accessPolicyId: "internal-project", actorId: serviceActor.actorId, actorType: "system", action: "create", targetType: "test_execution", targetId: body.runId, metadata: { provider, commitSha: body.commitSha, repository, acceptedCount } });
      }
      return { accepted: true, provider, handled: "test.results", runId: body.runId, acceptedCount, passed: normalized.filter((r) => r.status === "passed").length, failed: normalized.filter((r) => r.status === "failed").length, skipped: normalized.filter((r) => r.status === "skipped").length, duplicateCount };
    }
    if (body.eventType === "runner.question.response") {
      if (!webhookSecret) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Resposta do Runner '${provider}' requer segredo HMAC configurado.`, 401);
      if (!body.projectId || !body.taskId || !body.questionId || !body.response?.trim() || !body.idempotencyKey?.trim() || !body.externalUserId?.trim()) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "Resposta do Runner requer projectId, taskId, questionId, response, idempotencyKey e externalUserId.", 400);
      }
      assertProjectAccess(ctx, body.projectId);
      const questions = opRepo ? await opRepo.listRunnerTaskQuestions(ctx, body.projectId, body.taskId) : runner.listQuestions(ctx, body.taskId);
      const question = questions.find((entry) => entry.questionId === body.questionId);
      if (!question) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Pergunta '${body.questionId}' não encontrada para a tarefa.`, 404);
      const responsePolicyId = "accessPolicyId" in question ? question.accessPolicyId : "internal-project";
      const responseCtx = mapExternalHumanActor(ctx, provider, body.externalUserId, body.projectId, responsePolicyId);
      await enforceOpa(responseCtx, { projectId: body.projectId, accessPolicyId: responsePolicyId, action: "write" });
      const responseResult = opRepo
        ? await opRepo.answerRunnerQuestion(responseCtx, { projectId: body.projectId, taskId: body.taskId, questionId: body.questionId, response: body.response, idempotencyKey: `${provider}:${body.idempotencyKey}` })
        : runner.answerQuestion(responseCtx, body.taskId, { questionId: body.questionId, response: body.response, idempotencyKey: `${provider}:${body.idempotencyKey}` });
      if (!responseResult.duplicate) {
        await recordAudit(responseCtx, { tenantId: responseCtx.tenantId, projectId: body.projectId, accessPolicyId: responsePolicyId, actorId: responseCtx.actorId, actorType: "human", action: "update", targetType: "runner_task_question", targetId: body.questionId, metadata: { taskId: body.taskId, provider, externalUserId: body.externalUserId } });
      }
      return { accepted: true, provider, handled: "runner.question.response", questionId: "questionId" in responseResult ? responseResult.questionId : responseResult.question.questionId, status: "queued", responseRecorded: true, duplicate: responseResult.duplicate };
    }
    if (body.eventType === "approval.decision" && body.projectId && body.proposalId) {
      if (!webhookSecret) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Callback de aprovação '${provider}' requer segredo HMAC configurado.`, 401);
      const decision = body.decision ?? (body.approved === undefined ? undefined : body.approved ? "approve" : "reject");
      if (!decision) throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer decision ou approved legado.", 400);
      assertProjectAccess(ctx, body.projectId);
      if (ctx.actorType === "agent") throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Aprovação em canal externo exige identidade humana autenticada.", 403);
      const item = pgKnowledge ? await pgKnowledge.getItem(ctx, body.projectId, body.proposalId) : retrieval.getItem(ctx, body.projectId, body.proposalId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${body.proposalId}' não encontrada.`, 404);
      const externalUserId = body.externalUserId?.trim();
      if (!externalUserId) throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Callback de aprovação requer externalUserId assinado pelo provedor.", 401);
      const decisionCtx = mapExternalHumanActor(ctx, provider, externalUserId, body.projectId, item.accessPolicyId);
      if (!Number.isInteger(body.proposalVersion) || body.proposalVersion! < 1) throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer proposalVersion inteiro e positivo.", 400);
      await enforceOpa(decisionCtx, { projectId: body.projectId, accessPolicyId: item.accessPolicyId, action: "approve", domainId: item.domainId });
      const externalEventId = body.externalEventId?.trim();
      if (!externalEventId) throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação requer externalEventId para deduplicação.", 400);
      const eventHash = createHash("sha256").update(JSON.stringify({ projectId: body.projectId, proposalId: body.proposalId, proposalVersion: body.proposalVersion, decision, comment: body.comment ?? "", actorId: decisionCtx.actorId })).digest("hex");
      const eventKey = `${decisionCtx.tenantId}:${provider}:${externalEventId}`;
      let cachedResponse: Record<string, unknown> | undefined;
      let eventClaim: "claimed" | "duplicate" | "in_progress" | "key_conflict";
      if (opRepo) {
        const claim = await opRepo.claimIntegrationEvent(decisionCtx, { provider, externalEventId, projectId: body.projectId, proposalId: body.proposalId, accessPolicyId: item.accessPolicyId, eventHash });
        eventClaim = claim.state;
        cachedResponse = claim.response;
      } else {
        const existing = integrationEventMemory.get(eventKey);
        if (!existing) {
          integrationEventMemory.set(eventKey, { eventHash });
          eventClaim = "claimed";
        } else if (existing.eventHash !== eventHash) eventClaim = "key_conflict";
        else if (existing.response) {
          eventClaim = "duplicate";
          cachedResponse = existing.response;
        } else eventClaim = "in_progress";
      }
      if (eventClaim === "duplicate" && cachedResponse) return { ...cachedResponse, duplicate: true };
      if (eventClaim === "key_conflict") throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
      if (eventClaim === "in_progress" || eventClaim === "duplicate") throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de aprovação ainda está sendo processado.", 409);
      try {
        if (item.version !== body.proposalVersion) throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de decidir.`, 409);
        if (pgApprovals) {
          try {
            await pgApprovals.decide(decisionCtx, body.projectId, body.proposalId, decision, body.comment);
          } catch (err) {
            const code = (err as { code?: string } | undefined)?.code;
            if (code !== "BRAIN_ERR_NOT_FOUND") throw err;
          }
        } else if (approvals.hasRequest(decisionCtx, body.projectId, item.id)) approvals.decide(decisionCtx, body.projectId, body.proposalId, decision, body.comment);
        const updated = { ...item, status: decision === "approve" ? ("approved" as const) : decision === "reject" ? ("deprecated" as const) : item.status, isInferred: decision === "approve" ? false : item.isInferred, updatedAt: new Date().toISOString() };
        await upsertKnowledgeItem(decisionCtx, updated);
        await recordAudit(decisionCtx, { tenantId: ctx.tenantId, projectId: body.projectId, accessPolicyId: item.accessPolicyId, actorId: decisionCtx.actorId, actorType: decisionCtx.actorType, action: decision === "approve" ? "approve" : decision === "reject" ? "revoke" : "update", targetType: "integration_approval_event", targetId: item.id, metadata: { provider, externalEventId: body.externalEventId, externalUserId, decision, comment: body.comment } });
        const eventResponse = { accepted: true, provider, handled: "approval.decision", proposalId: item.id, status: decision === "request_changes" ? "changes_requested" : updated.status, knowledgeStatus: updated.status };
        if (opRepo) await opRepo.completeIntegrationEvent(decisionCtx, { provider, externalEventId, response: eventResponse });
        else integrationEventMemory.set(eventKey, { eventHash, response: eventResponse });
        return eventResponse;
      } catch (err) {
        try {
          if (opRepo) await opRepo.releaseIntegrationEvent(decisionCtx, provider, externalEventId);
          else integrationEventMemory.delete(eventKey);
        } catch {
          /* preserve error */
        }
        throw err;
      }
    }

    const item = handleSaasWebhook(provider as SaasProvider, body.payload ?? (body as Record<string, unknown>));
    assertSecretScanClean(scanForSecrets(`${item.title}\n${item.content}`), "Segredo detectado no evento de integração");
    assertProjectAccess(ctx, item.projectId);
    assertPolicyAccess(ctx, item.accessPolicyId);
    const originalContent = item.content;
    const originalTitle = item.title;
    const [sanitizedContent, sanitizedTitle] = await Promise.all([redactPiiWithAiWorker(item.content), redactPiiWithAiWorker(item.title)]);
    item.content = sanitizedContent;
    item.title = sanitizedTitle;
    item.contentHash = createHash("sha256").update(`${sanitizedTitle}\n${sanitizedContent}`).digest("hex");
    await upsertKnowledgeItem(ctx, item);
    await recordAudit(ctx, { tenantId: ctx.tenantId, projectId: item.projectId, accessPolicyId: item.accessPolicyId, actorId: ctx.actorId, actorType: ctx.actorType, action: "create", targetType: "knowledge_item", targetId: item.id, metadata: { source: "saas_integration_event", piiRedacted: sanitizedContent !== originalContent || sanitizedTitle !== originalTitle } });
    return { accepted: true, provider, handled: "ingestion", itemId: item.id };
  });

  const forwardInteractiveApprovalAction = async (
    provider: string,
    signingSecret: string,
    input: { projectId: string; proposalId: string; proposalVersion: number; decision: ApprovalDecision; externalUserId: string; externalEventId: string; comment?: string }
  ) => {
    const integrationEvent = {
      eventType: "approval.decision",
      projectId: input.projectId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      decision: input.decision,
      externalUserId: input.externalUserId,
      externalEventId: input.externalEventId,
      ...(input.comment ? { comment: input.comment } : {})
    };
    const eventSignature = createHmac("sha256", signingSecret).update(JSON.stringify(integrationEvent), "utf8").digest("hex");
    return app.inject({
      method: "POST",
      url: `/v1/integrations/${encodeURIComponent(provider)}/events`,
      headers: { authorization: `Bearer ${configuredApiKey}`, "content-type": "application/json", "x-noema-signature-256": `sha256=${eventSignature}` },
      payload: integrationEvent
    });
  };

  app.post<{ Body: { payload?: unknown } }>("/v1/integrations/slack/actions", async (req, reply) => {
    const signingSecret = process.env.NOEMA_WEBHOOK_SECRET_SLACK ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    if (!signingSecret || !rawBody || !verifySlackRequestSignature(rawBody, timestamp, signature, signingSecret)) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Assinatura Slack inválida ou expirada.", 401);
    }
    const payload = req.body?.payload as { type?: string; user?: { id?: string }; actions?: Array<{ action_id?: string; action_ts?: string; value?: string }> } | undefined;
    const action = payload?.actions?.[0];
    if (payload?.type !== "block_actions" || !payload.user?.id || !action?.action_id || !action.action_ts || !action.value) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Payload de ação Slack inválido.", 400);
    }
    const decisions: Record<string, ApprovalDecision> = { noema_approve: "approve", noema_reject: "reject", noema_request_changes: "request_changes" };
    const decision = decisions[action.action_id];
    if (!decision) throw new BrainError("BRAIN_ERR_CONFLICT", "Ação Slack desconhecida.", 400);
    let context: { projectId?: unknown; proposalId?: unknown; proposalVersion?: unknown };
    try {
      context = JSON.parse(action.value) as typeof context;
    } catch {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Contexto de aprovação Slack inválido.", 400);
    }
    if (typeof context.projectId !== "string" || typeof context.proposalId !== "string" || !Number.isInteger(context.proposalVersion) || Number(context.proposalVersion) < 1) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A ação Slack não contém projeto, proposta e versão válidos.", 400);
    }
    const result = await forwardInteractiveApprovalAction("slack", signingSecret, {
      projectId: context.projectId, proposalId: context.proposalId, proposalVersion: Number(context.proposalVersion),
      decision, externalUserId: payload.user.id, externalEventId: `${payload.user.id}:${action.action_ts}`
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return reply.code(200).send({ response_type: "ephemeral", text: "O Noema não conseguiu concluir a ação. Confira o estado da proposta no Command Center." });
    }
    return reply.code(200).send({ response_type: "ephemeral", text: "Decisão registrada no Noema." });
  });

  app.post<{ Params: { channel: string }; Body: Record<string, unknown> }>("/v1/integrations/:channel/actions", async (req, reply) => {
    const channel = req.params.channel.toLowerCase();
    if (!["teams", "jira", "clickup", "email"].includes(channel)) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Canal interativo '${req.params.channel}' não suportado.`, 404);
    const signingSecret = process.env[`NOEMA_WEBHOOK_SECRET_${channel.toUpperCase()}`] ?? process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    const rawBody = (req as typeof req & { noemaRawBody?: string }).noemaRawBody;
    const signature = req.headers["x-noema-signature-256"] as string | undefined;
    if (!signingSecret || !rawBody || !verifyChannelWebhookSignature(rawBody, signature, signingSecret)) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Assinatura ${channel} inválida ou ausente.`, 401);
    }
    const normalized = parseChannelActionPayload(channel as "teams" | "jira" | "clickup" | "email", (req.body ?? {}) as Record<string, unknown>);
    if (!normalized) throw new BrainError("BRAIN_ERR_CONFLICT", `Payload de ação ${channel} inválido.`, 400);
    const result = await forwardInteractiveApprovalAction(channel, signingSecret, {
      projectId: normalized.projectId, proposalId: normalized.proposalId, proposalVersion: normalized.proposalVersion,
      decision: normalized.decision, externalUserId: normalized.externalUserId, externalEventId: normalized.externalEventId, comment: normalized.comment
    });
    if (result.statusCode < 200 || result.statusCode >= 300) return reply.code(result.statusCode).send(result.json());
    return reply.code(200).send({ accepted: true, channel, decision: normalized.decision, result: result.json() });
  });
}

