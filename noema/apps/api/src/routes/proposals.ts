import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { BrainRunnerQueue } from "@noema/agent-runner";
import type { ApprovalDecision, ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AuditLogger } from "@noema/audit-engine";
import { canApproveDomain, type AuthContext } from "@noema/auth";
import { createBranchAndCommitFiles, createGitHubPullRequest } from "@noema/ingestion";
import { BrainError, paginateCursor, type KnowledgeItem } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@noema/graph";
import type { PostgresKnowledgeRepository } from "@noema/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { enqueueApprovalReminders, mapExternalHumanActor } from "../services/jobs.js";

export function registerProposalsRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    integrationEventMemory: Map<string, { eventHash: string; response?: Record<string, unknown> }>;
    opRepo?: PgOperationalRepository;
    pgApprovals?: PostgresApprovalQueue;
    approvals: ApprovalQueue;
    pgKnowledge?: PostgresKnowledgeRepository;
    pgRetrieval?: PostgresRetrievalEngine;
    retrieval: HybridRetrievalEngine;
    pgGraph?: PostgresGraphStore;
    graph: KnowledgeGraphStore;
    runner: BrainRunnerQueue;
    auditLogger?: AuditLogger;
  }
) {
  const {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    integrationEventMemory,
    opRepo,
    pgApprovals,
    approvals,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    pgGraph,
    graph,
    runner,
    auditLogger
  } = deps;

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/v1/projects/:projectId/proposals",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const requests = pgApprovals ? await pgApprovals.listPending(ctx, req.params.projectId) : approvals.listPending(ctx, req.params.projectId);
      const pending = requests.map((request) => ({ ...request.item, assignedTo: request.assignedTo, dueAt: request.dueAt, overdue: Date.parse(request.dueAt) <= Date.now() }));
      const page = paginateCursor(pending, Number(req.query.limit ?? 20), req.query.cursor);
      return { proposals: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/approval-reminders", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    if (!opRepo) return { reminders: [] };
    return { reminders: await opRepo.listApprovalReminderEvents(ctx, req.params.projectId) };
  });

  app.get<{ Params: { projectId: string; proposalId: string } }>("/v1/projects/:projectId/proposals/:proposalId/history", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId) : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
    if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
    await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "read", domainId: item.domainId });
    const memoryEvents = (auditLogger as (AuditLogger & { events?: Array<Record<string, unknown>> }) | undefined)?.events;
    const events = opRepo
      ? await opRepo.listProposalAuditHistory(ctx, req.params.projectId, req.params.proposalId)
      : (memoryEvents ?? []).filter(
          (event) =>
            event.projectId === req.params.projectId &&
            event.targetId === req.params.proposalId &&
            ["proposal", "proposal_revision", "approval_decision", "integration_approval_event", "proposal_assignment"].includes(String(event.targetType))
        );
    return { proposalId: req.params.proposalId, events };
  });

  app.post<{ Params: { projectId: string; proposalId: string }; Body: { provider: string; externalUserId: string } }>(
    "/v1/projects/:projectId/proposals/:proposalId/assign",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
        body: Type.Object({ provider: Type.String({ minLength: 1 }), externalUserId: Type.String({ minLength: 1 }) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId) : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "approve", domainId: item.domainId });
      const provider = req.body.provider.toLowerCase();
      const reviewer = mapExternalHumanActor(ctx, provider, req.body.externalUserId, req.params.projectId, item.accessPolicyId);
      if (!canApproveDomain(reviewer, item.domainId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O revisor mapeado não pode aprovar este domínio.", 403);
      const assigned = pgApprovals ? await pgApprovals.assign(ctx, req.params.projectId, req.params.proposalId, reviewer.actorId) : approvals.assign(ctx, req.params.projectId, req.params.proposalId, reviewer.actorId);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "proposal_assignment",
        targetId: req.params.proposalId,
        metadata: { assignedTo: reviewer.actorId, provider, externalUserId: req.body.externalUserId }
      });
      return { proposalId: req.params.proposalId, assignedTo: assigned.assignedTo, status: assigned.status };
    }
  );

  app.get<{ Params: { projectId: string }; Querystring: { rootId?: string; depth?: string } }>("/v1/projects/:projectId/graph", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const rootId = req.query.rootId ?? "BR-1";
    const hits = await (pgRetrieval ?? retrieval).search(ctx, { projectId: req.params.projectId, query: "", limit: 80 });
    const nodes = hits.map((h) => ({
      id: h.item.id,
      title: h.item.title,
      type: h.item.type,
      status: h.item.status
    }));
    const edges: Array<{ from: string; to: string; relation: string }> = [];
    const seen = new Set<string>();
    for (const n of nodes) {
      const related = pgGraph
        ? await pgGraph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: n.id }, 1)
        : graph.traverseRelated(ctx, { projectId: req.params.projectId, itemId: n.id }, 1);
      for (const hit of related) {
        if (hit.hops !== 1) continue;
        const key = `${n.id}|${hit.via}|${hit.itemId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: n.id, to: hit.itemId, relation: hit.via });
      }
    }
    return { projectId: req.params.projectId, rootId, nodes, edges };
  });

  app.post<{ Params: { projectId: string; proposalId: string } }>("/v1/projects/:projectId/proposals/:proposalId/approve", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const item = pgRetrieval ? await pgRetrieval.getItem(ctx, req.params.projectId, req.params.proposalId) : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
    if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
    if (ctx.actorType === "agent" && !ctx.inheritUserPermissions && !ctx.allowedActions?.includes("approve")) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Agentes não podem aprovar conhecimento oficial sem vínculo/delegação de usuário.", 403);
    }
    const approved = { ...item, status: "approved" as const, isInferred: false, updatedAt: new Date().toISOString() };
    await upsertKnowledgeItem(ctx, approved);
    if (pgApprovals) {
      try {
        await pgApprovals.decide(ctx, req.params.projectId, req.params.proposalId, true);
      } catch (err) {
        if (!(err instanceof BrainError && err.code === "BRAIN_ERR_NOT_FOUND")) throw err;
      }
    }
    pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);

    let prUrl: string | undefined;
    const ghToken = process.env.GITHUB_TOKEN;
    const ghRepo = process.env.GITHUB_REPO;
    if (ghToken && ghRepo && ghRepo.includes("/")) {
      const [owner, repo] = ghRepo.split("/");
      const headBranch = `brain/${item.id.toLowerCase()}`;
      const commitTitle = `chore(brain): approve ${item.id}`;
      await createBranchAndCommitFiles(owner!, repo!, "main", headBranch, [{ path: item.sourceUri || `.brain/01-business/${item.id}.md`, content: approved.content }], commitTitle, ghToken);
      const pr = await createGitHubPullRequest({
        owner: owner!,
        repo: repo!,
        title: commitTitle,
        head: headBranch,
        base: "main",
        body: `Aprovado por ${ctx.actorId} via Noema Command Center.`,
        token: ghToken
      });
      prUrl = pr.htmlUrl;
    }

    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: item.accessPolicyId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "approve",
      targetType: "knowledge_item",
      targetId: item.id,
      metadata: prUrl ? { prUrl } : undefined
    });
    return { approved: true, id: item.id, status: "approved", ...(prUrl ? { prUrl } : {}) };
  });

  app.post<{
    Params: { projectId: string; proposalId: string };
    Body: { approved?: boolean; decision?: ApprovalDecision; proposalVersion: number; comment?: string; channel?: string; externalEventId?: string };
  }>(
    "/v1/projects/:projectId/approvals/:proposalId/decision",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
        body: Type.Object({
          approved: Type.Optional(Type.Boolean()),
          decision: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("request_changes")])),
          proposalVersion: Type.Integer({ minimum: 1 }),
          comment: Type.Optional(Type.String()),
          channel: Type.Optional(Type.String()),
          externalEventId: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const decision = req.body.decision ?? (req.body.approved === undefined ? undefined : req.body.approved ? "approve" : "reject");
      if (!decision) throw new BrainError("BRAIN_ERR_CONFLICT", "Informe decision: approve, reject ou request_changes.", 400);
      if (ctx.actorType === "agent" && !ctx.inheritUserPermissions && !ctx.allowedActions?.includes("approve")) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Agentes não podem aprovar ou rejeitar propostas sem vínculo/delegação de usuário.", 403);
      }
      const item = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId) : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "approve", domainId: item.domainId });
      const channel = req.body.channel?.trim() || "api";
      const externalEventId = req.body.externalEventId?.trim();
      const eventProvider = `direct:${channel.toLowerCase()}`;
      const eventKey = `${ctx.tenantId}:${eventProvider}:${externalEventId ?? ""}`;
      let directEventClaimed = false;
      if (req.body.externalEventId !== undefined) {
        if (!externalEventId) throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId não pode estar vazio.", 400);
        const eventHash = createHash("sha256")
          .update(JSON.stringify({ projectId: req.params.projectId, proposalId: req.params.proposalId, proposalVersion: req.body.proposalVersion, decision, comment: req.body.comment ?? "", channel, actorId: ctx.actorId }))
          .digest("hex");
        if (opRepo) {
          const claim = await opRepo.claimIntegrationEvent(ctx, { provider: eventProvider, externalEventId, projectId: req.params.projectId, proposalId: req.params.proposalId, accessPolicyId: item.accessPolicyId, eventHash });
          if (claim.state === "duplicate" && claim.response) return { ...claim.response, duplicate: true };
          if (claim.state === "key_conflict") throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
          if (claim.state !== "claimed") throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de decisão ainda está sendo processado.", 409);
          directEventClaimed = true;
        } else {
          const existing = integrationEventMemory.get(eventKey);
          if (!existing) {
            integrationEventMemory.set(eventKey, { eventHash });
            directEventClaimed = true;
          } else if (existing.eventHash !== eventHash) throw new BrainError("BRAIN_ERR_CONFLICT", "externalEventId já foi usado com outro conteúdo.", 409);
          else if (existing.response) return { ...existing.response, duplicate: true };
          else throw new BrainError("BRAIN_ERR_CONFLICT", "Evento de decisão ainda está sendo processado.", 409);
        }
      }
      try {
        if (item.version !== req.body.proposalVersion) {
          throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de decidir.`, 409);
        }
        if (pgApprovals) {
          try {
            await pgApprovals.decide(ctx, req.params.projectId, req.params.proposalId, decision, req.body.comment);
          } catch (err) {
            const code = (err as { code?: string } | undefined)?.code;
            if (code !== "BRAIN_ERR_NOT_FOUND") throw err;
          }
        } else if (approvals.hasRequest(ctx, req.params.projectId, item.id)) {
          approvals.decide(ctx, req.params.projectId, req.params.proposalId, decision, req.body.comment);
        }
        const nextStatus = decision === "approve" ? ("approved" as const) : decision === "reject" ? ("deprecated" as const) : item.status;
        const updated = { ...item, status: nextStatus, isInferred: decision === "approve" ? false : item.isInferred, updatedAt: new Date().toISOString() };
        await upsertKnowledgeItem(ctx, updated);
        pgRetrieval?.invalidateCache(ctx.tenantId, req.params.projectId);
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: item.accessPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: decision === "approve" ? "approve" : decision === "reject" ? "revoke" : "update",
          targetType: "approval_decision",
          targetId: item.id,
          metadata: { decision, approved: decision === "approve", channel, externalEventId, comment: req.body.comment }
        });
        const response = {
          proposalId: item.id,
          decision: decision === "request_changes" ? "changes_requested" : decision === "approve" ? "approved" : "rejected",
          status: decision === "request_changes" ? "changes_requested" : nextStatus,
          knowledgeStatus: nextStatus,
          channel
        };
        if (directEventClaimed && externalEventId) {
          if (opRepo) await opRepo.completeIntegrationEvent(ctx, { provider: eventProvider, externalEventId, response });
          else {
            integrationEventMemory.set(eventKey, {
              eventHash: createHash("sha256")
                .update(JSON.stringify({ projectId: req.params.projectId, proposalId: req.params.proposalId, proposalVersion: req.body.proposalVersion, decision, comment: req.body.comment ?? "", channel, actorId: ctx.actorId }))
                .digest("hex"),
              response
            });
          }
        }
        return response;
      } catch (err) {
        if (directEventClaimed && externalEventId) {
          try {
            if (opRepo) await opRepo.releaseIntegrationEvent(ctx, eventProvider, externalEventId);
            else integrationEventMemory.delete(eventKey);
          } catch {
            /* preserve original error */
          }
        }
        throw err;
      }
    }
  );

  app.post<{ Params: { projectId: string; proposalId: string }; Body: { baseVersion: number; content: string } }>(
    "/v1/projects/:projectId/proposals/:proposalId/revise",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), proposalId: Type.String() }),
        body: Type.Object({ baseVersion: Type.Integer({ minimum: 1 }), content: Type.String({ minLength: 1 }) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const item = pgKnowledge ? await pgKnowledge.getItem(ctx, req.params.projectId, req.params.proposalId) : retrieval.getItem(ctx, req.params.projectId, req.params.proposalId);
      if (!item) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${req.params.proposalId}' não encontrada.`, 404);
      if (item.version !== req.body.baseVersion) throw new BrainError("BRAIN_ERR_CONFLICT", `A proposta mudou (versão atual: ${item.version}); atualize antes de revisar.`, 409);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
      const content = req.body.content.trim();
      if (!content) throw new BrainError("BRAIN_ERR_CONFLICT", "O conteúdo revisado não pode estar vazio.", 400);
      const revisedItem: KnowledgeItem = { ...item, content, status: "draft", version: item.version + 1, contentHash: createHash("sha256").update(content).digest("hex"), updatedAt: new Date().toISOString() };
      const revisedRequest = pgApprovals ? await pgApprovals.revise(ctx, req.params.projectId, req.params.proposalId, revisedItem) : approvals.revise(ctx, req.params.projectId, req.params.proposalId, revisedItem);
      await enqueueApprovalReminders(revisedRequest);
      await upsertKnowledgeItem(ctx, revisedItem);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "proposal_revision",
        targetId: req.params.proposalId,
        metadata: { baseVersion: item.version, version: revisedItem.version, reopened: true }
      });
      return { proposalId: req.params.proposalId, status: "pending", version: revisedItem.version };
    }
  );

  app.post<{ Params: { projectId: string; taskId: string }; Body: { questionId: string; response: string; idempotencyKey: string } }>(
    "/v1/projects/:projectId/runner/tasks/:taskId/responses",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), taskId: Type.String() }),
        body: Type.Object({ questionId: Type.String({ minLength: 1 }), response: Type.String({ minLength: 1 }), idempotencyKey: Type.String({ minLength: 1 }) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (ctx.actorType !== "human") throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Somente uma pessoa autenticada pode responder perguntas do Runner.", 403);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const result = opRepo
        ? await opRepo.answerRunnerQuestion(ctx, { projectId: req.params.projectId, taskId: req.params.taskId, questionId: req.body.questionId, response: req.body.response, idempotencyKey: req.body.idempotencyKey })
        : (() => {
            const answered = runner.answerQuestion(ctx, req.params.taskId, { questionId: req.body.questionId, response: req.body.response, idempotencyKey: req.body.idempotencyKey });
            return { questionId: answered.question.questionId, status: "queued" as const, responseRecorded: true as const, duplicate: answered.duplicate };
          })();
      if (!result.duplicate) {
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "runner_task_response",
          targetId: req.params.taskId,
          metadata: { questionId: req.body.questionId, idempotencyKey: req.body.idempotencyKey, resumed: true }
        });
      }
      return { taskId: req.params.taskId, ...result };
    }
  );
}

