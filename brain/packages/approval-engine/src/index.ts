import { randomUUID } from "node:crypto";
import { canApproveDomain, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export interface ApprovalRequest {
  proposalId: string;
  tenantId: string;
  projectId: string;
  item: KnowledgeItem;
  requestedBy: string;
  status: "pending" | "approved" | "rejected" | "changes_requested";
  reviewedBy?: string;
  assignedTo?: string;
  reviewNote?: string;
  prUrl?: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalDecision = "approve" | "reject" | "request_changes";

export class ApprovalQueue {
  private readonly items = new Map<string, ApprovalRequest>();
  constructor(private readonly now: () => Date = () => new Date(), private readonly slaHours = 72) {}

  submit(ctx: AuthContext, item: KnowledgeItem, prUrl?: string): ApprovalRequest {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const req: ApprovalRequest = {
      proposalId: item.id || `PROP-${randomUUID().slice(0, 8)}`,
      tenantId: ctx.tenantId,
      projectId: item.projectId,
      item: { ...item, status: "draft" },
      requestedBy: ctx.actorId,
      status: "pending",
      dueAt: new Date(nowDate.getTime() + this.slaHours * 3_600_000).toISOString(),
      prUrl,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(`${ctx.tenantId}:${item.projectId}:${req.proposalId}`, req);
    return req;
  }

  listPending(ctx: AuthContext, projectId: string): ApprovalRequest[] {
    return [...this.items.values()].filter(
      (r) => r.tenantId === ctx.tenantId && r.projectId === projectId && r.status === "pending"
    );
  }

  assign(ctx: AuthContext, projectId: string, proposalId: string, assigneeId: string): ApprovalRequest {
    const request = this.items.get(`${ctx.tenantId}:${projectId}:${proposalId}`);
    if (!request) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
    if (!ctx.allowedProjects.includes(projectId) || !ctx.allowedPolicies.includes(request.item.accessPolicyId) || !canApproveDomain(ctx, request.item.domainId)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Atribuir a revisão exige permissão de aprovação neste domínio.", 403);
    }
    if (request.status !== "pending") throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está pendente.`, 409);
    request.assignedTo = assigneeId;
    request.updatedAt = new Date().toISOString();
    return request;
  }

  hasRequest(ctx: AuthContext, projectId: string, proposalId: string): boolean {
    if (!ctx.allowedProjects.includes(projectId) || ctx.allowedPolicies.length === 0) return false;
    const request = this.items.get(`${ctx.tenantId}:${projectId}:${proposalId}`);
    return Boolean(request && ctx.allowedPolicies.includes(request.item.accessPolicyId));
  }

  revise(ctx: AuthContext, projectId: string, proposalId: string, item: KnowledgeItem): ApprovalRequest {
    const req = this.items.get(`${ctx.tenantId}:${projectId}:${proposalId}`);
    if (!req) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
    if (!ctx.allowedProjects.includes(projectId) || !ctx.allowedPolicies.includes(req.item.accessPolicyId)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Acesso negado à revisão desta proposta.", 403);
    }
    if (req.requestedBy !== ctx.actorId) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Somente o autor da proposta pode reenviá-la após solicitar alterações.", 403);
    if (req.status !== "changes_requested") throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está aguardando revisão (status: ${req.status}).`, 409);
    if (item.id !== proposalId || item.projectId !== projectId || item.tenantId !== ctx.tenantId || item.accessPolicyId !== req.item.accessPolicyId || item.version <= req.item.version) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A revisão deve manter o identificador e escopo da proposta e avançar sua versão.", 409);
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();
    req.item = { ...item, status: "draft" };
    req.status = "pending";
    req.requestedBy = ctx.actorId;
    req.reviewedBy = undefined;
    req.reviewNote = undefined;
    req.updatedAt = now;
    req.dueAt = new Date(nowDate.getTime() + this.slaHours * 3_600_000).toISOString();
    return req;
  }

  decide(
    ctx: AuthContext,
    projectId: string,
    proposalId: string,
    decision: boolean | ApprovalDecision,
    note?: string
  ): ApprovalRequest {
    const key = `${ctx.tenantId}:${projectId}:${proposalId}`;
    const req = this.items.get(key);
    if (!req) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
    }
    if (req.status !== "pending") {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está aguardando decisão (status: ${req.status}).`, 409);
    }
    if (req.assignedTo && req.assignedTo !== ctx.actorId) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `A revisão está atribuída a '${req.assignedTo}'.`, 403);
    }
    if (!canApproveDomain(ctx, req.item.domainId)) {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        `Ator '${ctx.actorId}' (${ctx.actorType}) não tem permissão para aprovar domínio ${req.item.domainId}.`,
        403
      );
    }
    const now = new Date().toISOString();
    const approve = decision === true || decision === "approve";
    req.status = approve ? "approved" : decision === "request_changes" ? "changes_requested" : "rejected";
    req.reviewedBy = ctx.actorId;
    req.reviewNote = note;
    req.updatedAt = now;
    if (approve) {
      req.item = { ...req.item, status: "approved", isInferred: false, updatedAt: now };
    }
    return req;
  }
}

export type ApprovalSqlParameter = string | number | boolean | null | readonly string[];

export type ApprovalSqlTransactionRunner = {
  <TRow = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly ApprovalSqlParameter[]
  ): PromiseLike<readonly TRow[]>;
};

export interface ApprovalRequestRow {
  proposal_id: string;
  tenant_id: string;
  project_id: string;
  item_json: KnowledgeItem | string;
  requested_by: string;
  status: string;
  reviewed_by: string | null;
  assigned_to?: string | null;
  review_note: string | null;
  pr_url: string | null;
  access_policy_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  due_at?: string | Date;
}

export interface PostgresApprovalQueueOptions<
  TTx extends ApprovalSqlTransactionRunner = ApprovalSqlTransactionRunner
> {
  client: AppPostgresClient<TTx>;
  now?: () => Date;
  slaHours?: number;
}

function toIsoString(val: string | Date): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

function parseItemJson(raw: KnowledgeItem | string): KnowledgeItem {
  if (typeof raw === "string") {
    return JSON.parse(raw) as KnowledgeItem;
  }
  return { ...raw };
}

function mapApprovalRow(row: ApprovalRequestRow): ApprovalRequest {
  return {
    proposalId: String(row.proposal_id),
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    item: parseItemJson(row.item_json),
    requestedBy: String(row.requested_by),
    status: row.status as ApprovalRequest["status"],
    ...(row.reviewed_by !== null && row.reviewed_by !== undefined ? { reviewedBy: String(row.reviewed_by) } : {}),
    ...(row.assigned_to !== null && row.assigned_to !== undefined ? { assignedTo: String(row.assigned_to) } : {}),
    ...(row.review_note !== null && row.review_note !== undefined ? { reviewNote: String(row.review_note) } : {}),
    ...(row.pr_url !== null && row.pr_url !== undefined ? { prUrl: String(row.pr_url) } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    dueAt: row.due_at ? toIsoString(row.due_at) : toIsoString(row.created_at)
  };
}

export class PostgresApprovalQueue<
  TTx extends ApprovalSqlTransactionRunner = ApprovalSqlTransactionRunner
> {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly now: () => Date;
  private readonly slaHours: number;

  constructor(
    clientOrOptions: AppPostgresClient<TTx> | PostgresApprovalQueueOptions<TTx>,
    maybeOptions?: { now?: () => Date; slaHours?: number }
  ) {
    let client: AppPostgresClient<TTx>;
    let now: (() => Date) | undefined;
    let slaHours: number | undefined;
    if ("client" in clientOrOptions) {
      client = clientOrOptions.client;
      now = clientOrOptions.now;
      slaHours = clientOrOptions.slaHours;
    } else {
      client = clientOrOptions;
      now = maybeOptions?.now;
      slaHours = maybeOptions?.slaHours;
    }
    if (!client || client.role !== "brain_app" || typeof client.withRlsTransaction !== "function") {
      throw new Error(
        "PostgresApprovalQueue requires a verified AppPostgresClient bound to role 'brain_app'."
      );
    }
    this.runInRlsTransaction = (ctx, cb) => client.withRlsTransaction(ctx, cb);
    this.now = now ?? (() => new Date());
    this.slaHours = slaHours ?? Number(process.env.BRAIN_APPROVAL_SLA_HOURS ?? 72);
    if (!Number.isFinite(this.slaHours) || this.slaHours <= 0 || this.slaHours > 8760) {
      throw new Error("BRAIN_APPROVAL_SLA_HOURS must be between 0 and 8760.");
    }
  }

  private resolveScope(ctx: AuthContext, projectId: string): { rlsContext: RlsSessionContext; policiesCsv: string } {
    if (!ctx.allowedProjects.includes(projectId)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Acesso negado ao projeto '${projectId}'.`, 403);
    }
    const rlsContext: RlsSessionContext = {
      tenantId: ctx.tenantId,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies
    };
    const resolved = resolveRlsSessionContext(rlsContext);
    return { rlsContext, policiesCsv: resolved.allowedPoliciesCsv };
  }

  async submit(ctx: AuthContext, item: KnowledgeItem, prUrl?: string): Promise<ApprovalRequest> {
    const { rlsContext } = this.resolveScope(ctx, item.projectId);
    if (!ctx.allowedPolicies.includes(item.accessPolicyId)) {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        `Política de acesso '${item.accessPolicyId}' não autorizada para '${ctx.actorId}'.`,
        403
      );
    }

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const dueIso = new Date(nowDate.getTime() + this.slaHours * 3_600_000).toISOString();
    const proposalId = item.id || `PROP-${randomUUID().slice(0, 8)}`;
    const draftItem: KnowledgeItem = { ...item, status: "draft" };

    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const rows = await tx<ApprovalRequestRow>`INSERT INTO approval_requests (
        proposal_id, tenant_id, project_id, item_id, domain_id, item_json,
        requested_by, status, pr_url, access_policy_id, created_at, updated_at, due_at
      ) VALUES (
        ${proposalId},
        ${ctx.tenantId},
        ${item.projectId},
        ${draftItem.id},
        ${draftItem.domainId},
        ${JSON.stringify(draftItem)}::jsonb,
        ${ctx.actorId},
        'pending',
        ${prUrl ?? null},
        ${item.accessPolicyId},
        ${nowIso}::timestamptz,
        ${nowIso}::timestamptz,
        ${dueIso}::timestamptz
      )
      RETURNING proposal_id, tenant_id, project_id, item_json, requested_by, status, reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at`;

      const row = rows[0];
      if (!row) {
        throw new Error("Falha ao registrar proposta em approval_requests.");
      }
      return mapApprovalRow(row);
    });
  }

  async revise(ctx: AuthContext, projectId: string, proposalId: string, item: KnowledgeItem): Promise<ApprovalRequest> {
    const { rlsContext, policiesCsv } = this.resolveScope(ctx, projectId);
    if (!ctx.allowedPolicies.includes(item.accessPolicyId)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Política de acesso '${item.accessPolicyId}' não autorizada para '${ctx.actorId}'.`, 403);
    }
    const revisionNow = this.now();
    const updatedAt = revisionNow.toISOString();
    const dueAt = new Date(revisionNow.getTime() + this.slaHours * 3_600_000).toISOString();
    const revisedItem: KnowledgeItem = { ...item, status: "draft", updatedAt };
    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const existingRows = await tx<ApprovalRequestRow>`SELECT
        proposal_id, tenant_id, project_id, item_json, requested_by, status,
        reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at
      FROM approval_requests
      WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}
        AND proposal_id = ${proposalId} AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))`;
      const existing = existingRows[0];
      if (!existing) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
      const current = mapApprovalRow(existing);
      if (current.requestedBy !== ctx.actorId) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Somente o autor da proposta pode reenviá-la após solicitar alterações.", 403);
      if (current.status !== "changes_requested") throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está aguardando revisão (status: ${current.status}).`, 409);
      if (item.id !== proposalId || item.projectId !== projectId || item.tenantId !== ctx.tenantId || item.accessPolicyId !== current.item.accessPolicyId || item.version <= current.item.version) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "A revisão deve manter o identificador e escopo da proposta e avançar sua versão.", 409);
      }
      const rows = await tx<ApprovalRequestRow>`UPDATE approval_requests
      SET status = 'pending', item_json = ${JSON.stringify(revisedItem)}::jsonb,
          requested_by = ${ctx.actorId}, reviewed_by = NULL, review_note = NULL,
          due_at = ${dueAt}::timestamptz,
          updated_at = ${updatedAt}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId} AND proposal_id = ${proposalId}
        AND status = 'changes_requested' AND requested_by = ${ctx.actorId}
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
      RETURNING proposal_id, tenant_id, project_id, item_json, requested_by, status,
        reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at`;
      if (!rows[0]) throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' mudou durante a revisão.`, 409);
      return mapApprovalRow(rows[0]);
    });
  }

  async listPending(ctx: AuthContext, projectId: string): Promise<ApprovalRequest[]> {
    if (!ctx.allowedProjects.includes(projectId) || ctx.allowedPolicies.length === 0) {
      return [];
    }
    const { rlsContext, policiesCsv } = this.resolveScope(ctx, projectId);
    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const rows = await tx<ApprovalRequestRow>`SELECT
        proposal_id, tenant_id, project_id, item_json, requested_by, status,
        reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at
      FROM approval_requests
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND status = 'pending'
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
      ORDER BY created_at ASC`;

      return rows.map(mapApprovalRow);
    });
  }

  async assign(ctx: AuthContext, projectId: string, proposalId: string, assigneeId: string): Promise<ApprovalRequest> {
    const { rlsContext, policiesCsv } = this.resolveScope(ctx, projectId);
    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const rows = await tx<ApprovalRequestRow>`SELECT
        proposal_id, tenant_id, project_id, item_json, requested_by, status,
        reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at
      FROM approval_requests
      WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId} AND proposal_id = ${proposalId}
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
      FOR UPDATE`;
      const currentRow = rows[0];
      if (!currentRow) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
      const current = mapApprovalRow(currentRow);
      if (current.status !== "pending") throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está pendente.`, 409);
      if (!canApproveDomain(ctx, current.item.domainId)) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Atribuir a revisão exige permissão de aprovação neste domínio.", 403);
      const nowIso = this.now().toISOString();
      const updated = await tx<ApprovalRequestRow>`UPDATE approval_requests
        SET assigned_to = ${assigneeId}, updated_at = ${nowIso}::timestamptz
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId} AND proposal_id = ${proposalId}
          AND status = 'pending' AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
        RETURNING proposal_id, tenant_id, project_id, item_json, requested_by, status,
          reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at`;
      if (!updated[0]) throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' mudou durante a atribuição.`, 409);
      return mapApprovalRow(updated[0]);
    });
  }

  async decide(
    ctx: AuthContext,
    projectId: string,
    proposalId: string,
    decision: boolean | ApprovalDecision,
    note?: string
  ): Promise<ApprovalRequest> {
    const { rlsContext, policiesCsv } = this.resolveScope(ctx, projectId);
    const nowIso = this.now().toISOString();

    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const existingRows = await tx<ApprovalRequestRow>`SELECT
        proposal_id, tenant_id, project_id, item_json, requested_by, status,
        reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at
      FROM approval_requests
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND proposal_id = ${proposalId}
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
      FOR UPDATE`;

      const existingRow = existingRows[0];
      if (!existingRow) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
      }

      const current = mapApprovalRow(existingRow);
      if (current.status !== "pending") {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Proposta '${proposalId}' não está aguardando decisão (status: ${current.status}).`, 409);
      }
      if (current.assignedTo && current.assignedTo !== ctx.actorId) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", `A revisão está atribuída a '${current.assignedTo}'.`, 403);
      }
      if (!canApproveDomain(ctx, current.item.domainId)) {
        throw new BrainError(
          "BRAIN_ERR_POLICY_DENIED",
          `Ator '${ctx.actorId}' (${ctx.actorType}) não tem permissão para aprovar domínio ${current.item.domainId}.`,
          403
        );
      }

      const approve = decision === true || decision === "approve";
      const nextStatus: ApprovalRequest["status"] = approve
        ? "approved"
        : decision === "request_changes"
          ? "changes_requested"
          : "rejected";
      const updatedItem: KnowledgeItem = approve
        ? { ...current.item, status: "approved", isInferred: false, updatedAt: nowIso }
        : current.item;

      const updatedRows = await tx<ApprovalRequestRow>`UPDATE approval_requests
      SET status = ${nextStatus},
          reviewed_by = ${ctx.actorId},
          review_note = ${note ?? null},
          item_json = ${JSON.stringify(updatedItem)}::jsonb,
          updated_at = ${nowIso}::timestamptz
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND proposal_id = ${proposalId}
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
      RETURNING proposal_id, tenant_id, project_id, item_json, requested_by, status, reviewed_by, assigned_to, review_note, pr_url, access_policy_id, created_at, updated_at, due_at`;

      const updatedRow = updatedRows[0];
      if (!updatedRow) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Proposta '${proposalId}' não encontrada.`, 404);
      }
      return mapApprovalRow(updatedRow);
    });
  }
}

export function createPostgresApprovalQueueForTesting<
  TTx extends ApprovalSqlTransactionRunner = ApprovalSqlTransactionRunner
>(sql: RlsSqlClient<TTx>, options?: { now?: () => Date }): PostgresApprovalQueue<TTx> {
  const fakeClient: AppPostgresClient<TTx> = {
    role: "brain_app",
    sql: sql as unknown as AppPostgresClient<TTx>["sql"],
    withRlsTransaction: (ctx, cb) => withRlsTransaction(sql, ctx, cb),
    async close() {}
  };
  return new PostgresApprovalQueue({ client: fakeClient, now: options?.now });
}

