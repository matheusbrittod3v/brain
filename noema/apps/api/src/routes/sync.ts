import type { FastifyInstance } from "fastify";
import type { ApprovalQueue, PostgresApprovalQueue } from "@noema/approval-engine";
import type { AuditLogger } from "@noema/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";
import type { PgOperationalRepository } from "@noema/database";
import { scanForSecrets } from "@noema/ingestion";
import { parseKnowledgeFile, type PostgresKnowledgeRepository } from "@noema/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@noema/retrieval";
import { assertSecretScanClean, redactPiiWithAiWorker } from "../services/ai-worker.js";
import { enqueueApprovalReminders } from "../services/jobs.js";

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: KnowledgeItem }>> };
    opRepo?: PgOperationalRepository;
    pgKnowledge?: PostgresKnowledgeRepository;
    pgRetrieval?: PostgresRetrievalEngine;
    retrieval: HybridRetrievalEngine;
    pgApprovals?: PostgresApprovalQueue;
    approvals: ApprovalQueue;
    policyEpochByProject: Map<string, { epoch: number; revocationFingerprint: string | null; allowedPolicyFingerprint: string }>;
  }
) {
  const {
    authenticateProjectRequest,
    recordAudit,
    upsertKnowledgeItem,
    queryAwareRetrieval,
    opRepo,
    pgKnowledge,
    pgRetrieval,
    retrieval,
    pgApprovals,
    approvals,
    policyEpochByProject
  } = deps;

  app.post<{
    Body: {
      projectId: string;
      sinceSeq?: number;
      policyEpoch?: number;
      snapshotSeq?: number;
      snapshotCursor?: string;
      pageSize?: number;
      knownPolicies?: string[];
    };
  }>("/v1/sync/pull", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
    const known = new Set(req.body.knownPolicies ?? []);
    const allowed = new Set(ctx.allowedPolicies);
    const revokedPolicies = [...known].filter((p) => !allowed.has(p));

    const epochKey = `${ctx.tenantId}:${req.body.projectId}:${ctx.actorId}`;
    let nextEpoch: number;
    if (opRepo) {
      nextEpoch = await opRepo.updatePolicyEpoch(ctx, req.body.projectId, revokedPolicies);
    } else {
      const allowedPolicyFingerprint = [...new Set(ctx.allowedPolicies)].sort().join("\u0000");
      const previousEpochState = policyEpochByProject.get(epochKey) ?? {
        epoch: 1,
        revocationFingerprint: null,
        allowedPolicyFingerprint
      };
      const revocationFingerprint = revokedPolicies.length > 0 ? [...new Set(revokedPolicies)].sort().join("\u0000") : null;
      const newRevocation = Boolean(revocationFingerprint && revocationFingerprint !== previousEpochState.revocationFingerprint);
      const policyScopeChanged = allowedPolicyFingerprint !== previousEpochState.allowedPolicyFingerprint;
      nextEpoch = newRevocation || policyScopeChanged ? previousEpochState.epoch + 1 : previousEpochState.epoch;
      policyEpochByProject.set(epochKey, { epoch: nextEpoch, revocationFingerprint, allowedPolicyFingerprint });
    }

    const sinceSeq = req.body.sinceSeq ?? 0;
    const pageSize = req.body.pageSize ?? 100;
    const snapshotContinuation = req.body.snapshotSeq !== undefined || req.body.snapshotCursor !== undefined;
    const deltaMode = Boolean(opRepo && pgKnowledge && sinceSeq > 0 && req.body.policyEpoch === nextEpoch && !snapshotContinuation);
    const pgChanges = deltaMode ? await opRepo!.pullSyncChanges(ctx, req.body.projectId, sinceSeq, pageSize) : [];
    let items: unknown[];
    let tombstones: string[];
    let syncMode: "snapshot" | "delta" = "snapshot";
    let snapshotSeq: number | undefined;
    let snapshotCursor: string | null = null;
    let snapshotDone = true;
    let snapshotRestarted = false;
    let responseSyncSeq = sinceSeq;
    if (deltaMode) {
      const latestChangeByItem = new Map<string, (typeof pgChanges)[number]>();
      for (const change of pgChanges) latestChangeByItem.set(change.itemId, change);
      const deltaItems: unknown[] = [];
      tombstones = [];
      for (const change of latestChangeByItem.values()) {
        const current = change.deletedAt ? undefined : await pgKnowledge!.getItem(ctx, req.body.projectId, change.itemId);
        if (current) deltaItems.push(current);
        else tombstones.push(change.itemId);
      }
      items = deltaItems;
      syncMode = "delta";
      responseSyncSeq = pgChanges.reduce((m, c) => Math.max(m, c.syncSeq), sinceSeq);
    } else {
      snapshotRestarted = snapshotContinuation && req.body.policyEpoch !== nextEpoch;
      const cursor = snapshotRestarted ? undefined : req.body.snapshotCursor;
      snapshotSeq =
        snapshotRestarted || req.body.snapshotSeq === undefined
          ? opRepo
            ? await opRepo.getLatestSyncSeq(ctx, req.body.projectId)
            : sinceSeq
          : req.body.snapshotSeq;
      if (opRepo && pgKnowledge) {
        const page = await pgKnowledge.listSyncSnapshot(ctx, req.body.projectId, cursor, pageSize);
        items = page;
        snapshotDone = page.length < pageSize;
        snapshotCursor = snapshotDone ? null : page.at(-1)?.id ?? null;
      } else {
        const hits = await queryAwareRetrieval.search(ctx, { projectId: req.body.projectId, query: "", limit: pageSize });
        items = hits.map((h) => h.item);
      }
      tombstones = [];
      responseSyncSeq = snapshotSeq;
    }

    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.body.projectId,
      accessPolicyId: ctx.allowedPolicies[0] ?? "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "sync_pull",
      targetType: "edge_snapshot",
      metadata: { count: items.length, revokedPolicies, policyEpoch: nextEpoch, sinceSeq, syncMode, snapshotSeq, snapshotCursor, snapshotDone, snapshotRestarted }
    });

    return {
      syncMode,
      syncSeq: responseSyncSeq,
      policyEpoch: nextEpoch,
      revokedPolicies,
      items,
      tombstones,
      ...(syncMode === "snapshot" ? { snapshotSeq, snapshotCursor, snapshotDone, snapshotRestarted } : {})
    };
  });

  app.post<{
    Body: {
      projectId: string;
      drafts: Array<{ id: string; title: string; content: string; accessPolicyId?: string; baseVersion?: number }>;
    };
  }>("/v1/sync/push", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
    const accepted: string[] = [];
    const conflicts: Array<{ id: string; proposalId: string; conflictWithVersion: number; status: "draft" }> = [];

    for (const draft of req.body.drafts) {
      const scan = scanForSecrets(`${draft.title}\n${draft.content}`);
      assertSecretScanClean(scan, `Segredo detectado no sync push (${draft.id})`);
      const [redactedContent, redactedTitle] = await Promise.all([
        redactPiiWithAiWorker(draft.content),
        redactPiiWithAiWorker(draft.title)
      ]);
      const policy = draft.accessPolicyId ?? "internal-project";
      assertPolicyAccess(ctx, policy);

      const existing =
        draft.baseVersion !== undefined
          ? pgRetrieval
            ? await pgRetrieval.getItem(ctx, req.body.projectId, draft.id)
            : retrieval.getItem(ctx, req.body.projectId, draft.id)
          : undefined;

      if (existing && draft.baseVersion !== undefined && existing.version > draft.baseVersion) {
        const conflictProposalId = `${draft.id}-conflict-v${existing.version}`;
        const conflictItem = parseKnowledgeFile({
          tenantId: ctx.tenantId,
          projectId: req.body.projectId,
          filePath: `.brain/08-agent-memory/${conflictProposalId}.md`,
          rawContent: `---\nid: ${conflictProposalId}\ntitle: ${redactedTitle}\nstatus: draft\naccess_policy: ${policy}\n---\n\n${redactedContent}`
        });
        conflictItem.metadata = { ...conflictItem.metadata, conflictWithVersion: existing.version, conflictForId: draft.id };
        await upsertKnowledgeItem(ctx, conflictItem);
        const conflictRequest = pgApprovals ? await pgApprovals.submit(ctx, conflictItem) : approvals.submit(ctx, conflictItem);
        await enqueueApprovalReminders(conflictRequest);
        conflicts.push({ id: draft.id, proposalId: conflictProposalId, conflictWithVersion: existing.version, status: "draft" });
        accepted.push(conflictProposalId);
        continue;
      }

      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId: req.body.projectId,
        filePath: `.brain/08-agent-memory/${draft.id}.md`,
        rawContent: `---\nid: ${draft.id}\ntitle: ${redactedTitle}\nstatus: draft\naccess_policy: ${policy}\n---\n\n${redactedContent}`
      });
      await upsertKnowledgeItem(ctx, item);
      accepted.push(item.id);
    }

    pgRetrieval?.invalidateCache(ctx.tenantId, req.body.projectId);

    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.body.projectId,
      accessPolicyId: ctx.allowedPolicies[0] ?? "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "sync_push",
      targetType: "edge_drafts",
      metadata: { accepted, conflicts }
    });

    return {
      acceptedCount: accepted.length,
      acceptedIds: accepted,
      status: "draft",
      ...(conflicts.length > 0 ? { conflicts } : {})
    };
  });
}

