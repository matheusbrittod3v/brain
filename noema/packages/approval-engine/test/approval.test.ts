import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalQueue,
  createPostgresApprovalQueueForTesting,
  type ApprovalRequestRow,
  type ApprovalSqlParameter,
  type ApprovalSqlTransactionRunner
} from "../src/index.js";

test("ApprovalQueue blocks agent approval on critical domains and allows human tech-lead", () => {
  let currentNow = new Date("2026-11-16T20:00:00.000Z");
  const q = new ApprovalQueue(() => new Date(currentNow), 2);
  const now = currentNow.toISOString();
  const devCtx = {
    tenantId: "acme",
    actorId: "agent-1",
    actorType: "agent" as const,
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };
  const leadCtx = {
    tenantId: "acme",
    actorId: "lead-1",
    actorType: "human" as const,
    roles: ["tech-lead"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const req = q.submit(devCtx, {
    id: "BR-1",
    tenantId: "acme",
    projectId: "sub",
    domainId: 2,
    type: "business_rule",
    title: "Regra",
    content: "Conteúdo",
    status: "draft",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "agent",
    sourceVersion: "v1",
    sourceUri: ".brain/BR-1.md",
    version: 1,
    contentHash: "h1",
    confidence: 0.8,
    trustLevel: "self_authored",
    isInferred: true,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    createdAt: now,
    updatedAt: now
  });
  assert.equal(req.dueAt, "2026-11-16T22:00:00.000Z");

  assert.throws(() => q.decide(devCtx, "sub", req.proposalId, true));
  const approved = q.decide(leadCtx, "sub", req.proposalId, true, "Aprovado");
  assert.equal(approved.status, "approved");
  assert.equal(approved.item.status, "approved");

  const changeReq = q.submit(leadCtx, { ...req.item, id: "BR-2" });
  const changes = q.decide(leadCtx, "sub", changeReq.proposalId, "request_changes", "Faltam critérios de aceite");
  assert.equal(changes.status, "changes_requested");
  assert.equal(changes.item.status, "draft");
  assert.equal(changes.reviewNote, "Faltam critérios de aceite");
  assert.throws(
    () => q.decide(leadCtx, "sub", changeReq.proposalId, "approve"),
    (error: { code?: string }) => error.code === "BRAIN_ERR_CONFLICT"
  );
  currentNow = new Date("2026-11-17T02:00:00.000Z");
  const revised = q.revise(leadCtx, "sub", changeReq.proposalId, {
    ...changeReq.item, version: 2, content: "Conteúdo revisado", contentHash: "h2", status: "draft"
  });
  assert.equal(revised.proposalId, changeReq.proposalId);
  assert.equal(revised.status, "pending");
  assert.equal(revised.item.version, 2);
  assert.equal(revised.reviewNote, undefined);
  assert.equal(revised.dueAt, "2026-11-17T04:00:00.000Z");
  assert.equal(q.listPending(leadCtx, "sub").some((entry) => entry.proposalId === changeReq.proposalId), true);
  assert.throws(() => q.revise({ ...leadCtx, actorId: "other-author" }, "sub", changeReq.proposalId, {
    ...revised.item, version: 3, content: "Tentativa de outro autor", contentHash: "h3"
  }), (error: { code?: string }) => error.code === "BRAIN_ERR_POLICY_DENIED");
});

test("PostgresApprovalQueue persists approval_requests inside RLS transaction and enforces domain permissions", async () => {
  const rows: ApprovalRequestRow[] = [];
  const fakeSql = {
    async begin<T>(cb: (tx: ApprovalSqlTransactionRunner) => T | Promise<T>): Promise<T> {
      let gucTenant = "";
      let gucProjects = new Set<string>();
      let gucPolicies = new Set<string>();

      const tx = (async <TRow = Record<string, unknown>>(
        template: TemplateStringsArray,
        ...params: readonly ApprovalSqlParameter[]
      ): Promise<readonly TRow[]> => {
        const sqlText = template.join("$P$").replace(/\s+/g, " ").trim();
        if (sqlText.includes("set_config('app.current_tenant_id'")) {
          gucTenant = String(params[0] ?? "");
          gucProjects = new Set(String(params[1] ?? "").split(",").filter(Boolean));
          gucPolicies = new Set(String(params[2] ?? "").split(",").filter(Boolean));
          return [] as unknown as readonly TRow[];
        }
        if (!gucTenant) throw new Error("Missing RLS GUCs");

        if (sqlText.startsWith("INSERT INTO approval_requests")) {
          const [
            proposalId,
            tenantId,
            projectId,
            _itemId,
            _domainId,
            itemJson,
            requestedBy,
            prUrl,
            accessPolicyId,
            createdAt,
            updatedAt,
            dueAt
          ] = params as [string, string, string, string, number, string, string, string | null, string, string, string, string];
          const inserted: ApprovalRequestRow = {
            proposal_id: proposalId,
            tenant_id: tenantId,
            project_id: projectId,
            item_json: itemJson,
            requested_by: requestedBy,
            status: "pending",
            reviewed_by: null,
            review_note: null,
            pr_url: prUrl,
            access_policy_id: accessPolicyId,
            created_at: createdAt,
            updated_at: updatedAt,
            due_at: dueAt
          };
          rows.push(inserted);
          return [inserted] as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("SELECT") && sqlText.includes("status = 'pending'")) {
          const [tenantId, projectId, policiesCsv] = params as [string, string, string];
          const allowedPol = new Set(policiesCsv.split(",").filter(Boolean));
          return rows.filter(
            (r) =>
              r.tenant_id === gucTenant &&
              gucProjects.has(r.project_id) &&
              gucPolicies.has(r.access_policy_id) &&
              r.tenant_id === tenantId &&
              r.project_id === projectId &&
              r.status === "pending" &&
              allowedPol.has(r.access_policy_id)
          ) as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("SELECT") && sqlText.includes("FROM approval_requests")) {
          const [tenantId, projectId, proposalId, policiesCsv] = params as [string, string, string, string];
          const allowedPol = new Set(policiesCsv.split(",").filter(Boolean));
          return rows.filter(
            (r) =>
              r.tenant_id === gucTenant &&
              gucProjects.has(r.project_id) &&
              gucPolicies.has(r.access_policy_id) &&
              r.tenant_id === tenantId &&
              r.project_id === projectId &&
              r.proposal_id === proposalId &&
              allowedPol.has(r.access_policy_id)
          ) as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("UPDATE approval_requests")) {
          if (sqlText.includes("SET status = 'pending'")) {
            const [itemJson, requestedBy, dueAt, updatedAt, tenantId, projectId, proposalId] = params as [string, string, string, string, string, string, string];
            const target = rows.find((r) => r.tenant_id === tenantId && r.project_id === projectId && r.proposal_id === proposalId);
            if (!target || target.status !== "changes_requested" || target.requested_by !== requestedBy) return [] as unknown as readonly TRow[];
            target.status = "pending";
            target.item_json = itemJson;
            target.updated_at = updatedAt;
            target.due_at = dueAt;
            target.reviewed_by = null;
            target.review_note = null;
            return [target] as unknown as readonly TRow[];
          }
          const [nextStatus, reviewedBy, reviewNote, itemJson, updatedAt, tenantId, projectId, proposalId] =
            params as [string, string, string | null, string, string, string, string, string];
          const target = rows.find(
            (r) => r.tenant_id === tenantId && r.project_id === projectId && r.proposal_id === proposalId
          );
          if (!target) return [] as unknown as readonly TRow[];
          target.status = nextStatus;
          target.reviewed_by = reviewedBy;
          target.review_note = reviewNote;
          target.item_json = itemJson;
          target.updated_at = updatedAt;
          return [target] as unknown as readonly TRow[];
        }

        return [] as unknown as readonly TRow[];
      }) as ApprovalSqlTransactionRunner;

      return await cb(tx);
    }
  };

  const queue = createPostgresApprovalQueueForTesting(fakeSql, {
    now: () => new Date("2026-11-16T20:00:00.000Z")
  });

  const devCtx = {
    tenantId: "acme",
    actorId: "agent-1",
    actorType: "agent" as const,
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };
  const leadCtx = {
    tenantId: "acme",
    actorId: "lead-1",
    actorType: "human" as const,
    roles: ["tech-lead"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const req = await queue.submit(devCtx, {
    id: "BR-PG-1",
    tenantId: "acme",
    projectId: "sub",
    domainId: 2,
    type: "business_rule",
    title: "Regra PG",
    content: "Conteudo",
    status: "draft",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "agent",
    sourceVersion: "v1",
    sourceUri: ".brain/BR-PG-1.md",
    version: 1,
    contentHash: "h1",
    confidence: 0.8,
    trustLevel: "self_authored",
    isInferred: true,
    tags: [],
    relatedIds: [],
    accessPolicyId: "internal-project",
    createdAt: "2026-11-16T20:00:00.000Z",
    updatedAt: "2026-11-16T20:00:00.000Z"
  });

  const pending = await queue.listPending(leadCtx, "sub");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.proposalId, "BR-PG-1");

  await assert.rejects(() => queue.decide(devCtx, "sub", req.proposalId, true));
  const approved = await queue.decide(leadCtx, "sub", req.proposalId, true, "Aprovado no PG");
  assert.equal(approved.status, "approved");
  assert.equal(approved.item.status, "approved");
  assert.equal(approved.item.isInferred, false);
  assert.equal((await queue.listPending(leadCtx, "sub")).length, 0);

  const changeReq = await queue.submit(leadCtx, { ...req.item, id: "BR-PG-2" });
  const changes = await queue.decide(leadCtx, "sub", changeReq.proposalId, "request_changes", "Adicionar testes");
  assert.equal(changes.status, "changes_requested");
  assert.equal(changes.item.status, "draft");
  assert.equal(changes.reviewNote, "Adicionar testes");
  await assert.rejects(
    () => queue.decide(leadCtx, "sub", changeReq.proposalId, "approve"),
    (error: { code?: string }) => error.code === "BRAIN_ERR_CONFLICT"
  );
  const revised = await queue.revise(leadCtx, "sub", changeReq.proposalId, {
    ...changeReq.item, version: 2, content: "Conteúdo revisado", contentHash: "h2", status: "draft"
  });
  assert.equal(revised.status, "pending");
  assert.equal(revised.item.version, 2);
  assert.equal(revised.reviewNote, undefined);
  assert.equal((await queue.listPending(leadCtx, "sub")).some((entry) => entry.proposalId === changeReq.proposalId), true);
  await assert.rejects(() => queue.revise({ ...leadCtx, actorId: "other-author" }, "sub", changeReq.proposalId, {
    ...revised.item, version: 3, content: "Tentativa de outro autor", contentHash: "h3"
  }), (error: { code?: string }) => error.code === "BRAIN_ERR_POLICY_DENIED");
});

