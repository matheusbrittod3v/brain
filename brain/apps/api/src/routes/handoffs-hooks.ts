import type { FastifyInstance } from "fastify";
import type { HandoffStore } from "@brain/agent-handoff";
import type { AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import type { PgOperationalRepository } from "@brain/database";
import { scanForSecrets } from "@brain/ingestion";
import { assertSecretScanClean } from "../services/ai-worker.js";

export function registerHandoffsHooksRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforcePolicy: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    getDeveloperProfile: (ctx: AuthContext) => Promise<{ optInCrossProject?: boolean } | undefined>;
    handoffs: HandoffStore;
    opRepo?: PgOperationalRepository;
  }
) {
  const { authenticateProjectRequest, enforcePolicy, recordAudit, getDeveloperProfile, handoffs, opRepo } = deps;

  app.post<{
    Params: { projectId: string };
    Body: { taskId: string; fromAgent: string; repoUrl: string; branch: string; baseCommitSha: string; modifiedFiles: string[]; nextSteps: string[] };
  }>("/v1/projects/:projectId/handoffs", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const created = handoffs.createHandoff(ctx, {
      ...req.body,
      projectId: req.params.projectId,
      workingTreeDirty: false,
      testsExecuted: [],
      decisions: []
    });
    if (opRepo) {
      await opRepo.saveHandoff(ctx, created);
      await opRepo.upsertLease(ctx, req.params.projectId, created.taskId, created.branch);
    }
    return created;
  });

  app.get<{ Params: { projectId: string }; Querystring: { taskId?: string; limit?: number } }>(
    "/v1/projects/:projectId/handoffs",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (opRepo) {
        if (req.query.taskId) {
          const latest = await opRepo.getLatestHandoff(ctx, req.params.projectId, req.query.taskId);
          return { handoffs: latest ? [latest] : [] };
        }
        const items = await opRepo.listHandoffs(ctx, req.params.projectId, Math.min(50, Math.max(1, Number(req.query.limit ?? 20))));
        return { handoffs: items };
      }
      const latest = handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.query.taskId }).handoff;
      return { handoffs: latest ? [latest] : [] };
    }
  );

  app.get<{ Params: { projectId: string }; Querystring: { taskId?: string } }>(
    "/v1/projects/:projectId/handoffs/latest",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (opRepo) {
        const latest = await opRepo.getLatestHandoff(ctx, req.params.projectId, req.query.taskId);
        return { handoff: latest ?? null, warnings: latest ? [] : ["Nenhum handoff encontrado."] };
      }
      return handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.query.taskId });
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      harness: string;
      event: "session_start" | "tool_use" | "session_end" | "pre_compact";
      sessionId: string;
      summary?: string;
      modifiedFiles?: string[];
      branch?: string;
      commitSha?: string;
      usedItemIds?: string[];
      taskId?: string;
    };
  }>("/v1/projects/:projectId/hooks/lifecycle", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
    const harness = req.body.harness?.trim() || "unknown";
    const summary = req.body.summary?.trim() ?? "";
    if (summary) {
      const scan = scanForSecrets(summary);
      assertSecretScanClean(scan, "Segredo detectado no payload de lifecycle hook");
    }
    const warnings: string[] = [];
    const memoryLayer = req.body.event === "session_end" || req.body.event === "pre_compact" ? "episodic" : "working";
    const memoryContent = summary || `[${harness}] ${req.body.event} (session=${req.body.sessionId})`;
    if (opRepo) {
      await opRepo.appendMemory(ctx, {
        projectId: req.params.projectId,
        sessionId: req.body.sessionId,
        layer: memoryLayer,
        content: memoryContent,
        accessPolicyId: "internal-project"
      });
    }
    let citationsRecorded = 0;
    if (opRepo && req.body.usedItemIds && req.body.usedItemIds.length > 0) {
      try {
        await opRepo.recordContextEvidence(ctx, req.params.projectId, req.body.sessionId, req.body.usedItemIds, "citation");
        citationsRecorded = req.body.usedItemIds.length;
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : "Não foi possível registrar citação automática.");
      }
    }
    let handoffCreated: { handoffId: string; taskId: string } | undefined;
    if (req.body.event === "session_end" && (summary || (req.body.modifiedFiles?.length ?? 0) > 0)) {
      const taskId = req.body.taskId?.trim() || `HOOK-${req.body.sessionId.slice(0, 12)}`;
      const created = handoffs.createHandoff(ctx, {
        projectId: req.params.projectId,
        taskId,
        fromAgent: harness,
        repoUrl: "",
        branch: req.body.branch?.trim() || "main",
        baseCommitSha: req.body.commitSha?.trim() || "HEAD",
        workingTreeDirty: (req.body.modifiedFiles?.length ?? 0) > 0,
        modifiedFiles: req.body.modifiedFiles ?? [],
        testsExecuted: [],
        decisions: summary ? [summary] : [],
        nextSteps: summary ? [`Retomar sessão (${harness}): ${summary.slice(0, 160)}`] : ["Retomar sessão anterior"]
      });
      if (opRepo) {
        await opRepo.saveHandoff(ctx, created);
        await opRepo.upsertLease(ctx, req.params.projectId, created.taskId, created.branch);
      }
      handoffCreated = { handoffId: created.handoffId, taskId: created.taskId };
    }
    const developerProfile = req.body.event === "session_start" ? await getDeveloperProfile(ctx) : undefined;
    const latestHandoff =
      req.body.event === "session_start"
        ? opRepo
          ? await opRepo.getLatestHandoff(ctx, req.params.projectId, req.body.taskId)
          : handoffs.resumeHandoff(ctx, { projectId: req.params.projectId, taskId: req.body.taskId }).handoff
        : undefined;
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "create",
      targetType: "lifecycle_hook",
      targetId: `${harness}:${req.body.event}`,
      metadata: { sessionId: req.body.sessionId, citationsRecorded, handoffId: handoffCreated?.handoffId }
    });
    return {
      ok: true,
      harness,
      event: req.body.event,
      sessionId: req.body.sessionId,
      memoryLayer,
      citationsRecorded,
      ...(handoffCreated ? { handoffCreated } : {}),
      ...(developerProfile?.optInCrossProject ? { developerProfile } : {}),
      ...(latestHandoff ? { latestHandoff } : {}),
      warnings
    };
  });
}
