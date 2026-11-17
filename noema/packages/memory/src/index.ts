import { randomUUID } from "node:crypto";
import type { AuthContext } from "@noema/auth";
import { BrainError } from "@noema/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type RlsSessionContext,
  type RlsSqlClient
} from "@noema/database";

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "organizational";

export interface MemoryEntry {
  id: string;
  tenantId: string;
  projectId: string;
  actorId: string;
  sessionId?: string;
  layer: MemoryLayer;
  content: string;
  isInferred: boolean;
  confidence: number;
  status: "draft" | "approved";
  hitCount: number;
  createdAt: string;
  expiresAt?: string;
  archivedAt?: string;
}

const WORKING_TTL_MS = 24 * 60 * 60 * 1000;
const EPISODIC_RETENTION_DAYS = 60;
const EPISODIC_TTL_MS = EPISODIC_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Gerenciador de Memória em 5 Camadas (Item 9):
 * Working (24h TTL) -> Episodic (60d) -> Semantic (is_inferred=true) -> Procedural (Git) -> Organizational (aprovação humana).
 */
export class MemoryManager {
  private readonly entries: MemoryEntry[] = [];

  record(
    ctx: AuthContext,
    input: {
      projectId: string;
      layer: MemoryLayer;
      content: string;
      sessionId?: string;
      humanApproved?: boolean;
    }
  ): MemoryEntry {
    if (input.layer === "organizational" && !input.humanApproved) {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        "Promoção para Organizational Memory exige aprovação humana explícita via PR ou Command Center.",
        403
      );
    }
    if (input.layer === "organizational" && ctx.actorType === "agent") {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        "Agentes nunca podem escrever diretamente na Organizational Memory.",
        403
      );
    }

    const now = new Date();
    const expiresAt =
      input.layer === "working"
        ? new Date(now.getTime() + WORKING_TTL_MS).toISOString()
        : input.layer === "episodic"
          ? new Date(now.getTime() + EPISODIC_TTL_MS).toISOString()
          : undefined;

    const entry: MemoryEntry = {
      id: `MEM-${randomUUID().slice(0, 8)}`,
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      actorId: ctx.actorId,
      sessionId: input.sessionId,
      layer: input.layer,
      content: input.content,
      isInferred: input.layer === "semantic",
      confidence: input.layer === "semantic" ? 0.75 : 1.0,
      status: input.layer === "organizational" || input.layer === "procedural" ? "approved" : "draft",
      hitCount: 0,
      createdAt: now.toISOString(),
      expiresAt
    };

    this.entries.push(entry);
    return entry;
  }

  listVisible(ctx: AuthContext, projectId: string, sessionId?: string, now = new Date()): MemoryEntry[] {
    const nowMs = now.getTime();
    return this.entries.filter((e) => {
      if (e.tenantId !== ctx.tenantId || e.projectId !== projectId || e.archivedAt) return false;
      if (e.expiresAt && new Date(e.expiresAt).getTime() <= nowMs) return false;
      if (e.layer === "working" && e.sessionId && sessionId && e.sessionId !== sessionId) return false;
      return true;
    });
  }

  recordHit(ctx: AuthContext, memoryId: string, weight = 1, now = new Date()): MemoryEntry | undefined {
    const entry = this.entries.find((e) => e.tenantId === ctx.tenantId && e.id === memoryId && !e.archivedAt);
    if (!entry) return undefined;
    const boost = Math.max(1, Math.floor(weight));
    entry.hitCount += boost;
    if (entry.layer === "episodic" && entry.expiresAt) {
      const graceMs = Math.min(90, entry.hitCount * 7) * 24 * 60 * 60 * 1000;
      const extended = new Date(new Date(entry.createdAt).getTime() + EPISODIC_TTL_MS + graceMs);
      if (extended.getTime() > now.getTime()) {
        entry.expiresAt = extended.toISOString();
      }
    }
    return entry;
  }

  /**
   * Access-weighted Memory Decay: memórias episódicas sem uso decaem em 60 dias;
   * memórias com hitCount > 0 recebem extensão de retenção (15 dias por hit, máx. +90d).
   */
  runDecay(ctx: AuthContext, projectId: string, now = new Date()): { archivedCount: number; retainedByAccessCount: number; semanticCreated?: MemoryEntry } {
    const baseMs = EPISODIC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const candidates = this.entries.filter(
      (e) =>
        e.tenantId === ctx.tenantId &&
        e.projectId === projectId &&
        e.layer === "episodic" &&
        !e.archivedAt &&
        new Date(e.createdAt).getTime() < now.getTime() - baseMs
    );
    let retainedByAccessCount = 0;
    const stale = candidates.filter((e) => {
      const graceMs = Math.min(90, Math.max(0, e.hitCount) * 15) * 24 * 60 * 60 * 1000;
      const expired = new Date(e.createdAt).getTime() + baseMs + graceMs < now.getTime();
      if (!expired && e.hitCount > 0) retainedByAccessCount += 1;
      return expired;
    });

    if (stale.length === 0) return { archivedCount: 0, retainedByAccessCount };

    const nowIso = now.toISOString();
    for (const item of stale) {
      item.archivedAt = nowIso;
    }

    const semanticCreated = this.record(ctx, {
      projectId,
      layer: "semantic",
      content: `Resumo consolidado de ${stale.length} memórias episódicas antigas: ${stale
        .slice(0, 5)
        .map((s) => s.content.slice(0, 80))
        .join(" | ")}`
    });

    return { archivedCount: stale.length, retainedByAccessCount, semanticCreated };
  }
}

export type MemorySqlParameter = string | number | boolean | null | readonly string[];

export type MemorySqlTransactionRunner = {
  <TRow = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly MemorySqlParameter[]
  ): PromiseLike<readonly TRow[]>;
};

export interface MemoryEntryRow {
  id: string;
  tenant_id: string;
  project_id: string;
  layer: string;
  session_id: string | null;
  content: string;
  access_policy_id: string;
  expires_at: string | Date | null;
  created_at: string | Date;
}

export interface PostgresMemoryManagerOptions<
  TTx extends MemorySqlTransactionRunner = MemorySqlTransactionRunner
> {
  client: AppPostgresClient<TTx>;
  now?: () => Date;
}

function toIso(val: string | Date): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

function mapMemoryRow(row: MemoryEntryRow, actorId: string): MemoryEntry {
  const layer = row.layer as MemoryLayer;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    actorId,
    ...(row.session_id !== null && row.session_id !== undefined ? { sessionId: String(row.session_id) } : {}),
    layer,
    content: String(row.content),
    isInferred: layer === "semantic",
    confidence: layer === "semantic" ? 0.75 : 1.0,
    status: layer === "organizational" || layer === "procedural" ? "approved" : "draft",
    hitCount: 0,
    createdAt: toIso(row.created_at),
    ...(row.expires_at !== null && row.expires_at !== undefined ? { expiresAt: toIso(row.expires_at) } : {})
  };
}

export class PostgresMemoryManager<
  TTx extends MemorySqlTransactionRunner = MemorySqlTransactionRunner
> {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly now: () => Date;

  constructor(
    clientOrOptions: AppPostgresClient<TTx> | PostgresMemoryManagerOptions<TTx>,
    maybeOptions?: { now?: () => Date }
  ) {
    let client: AppPostgresClient<TTx>;
    let now: (() => Date) | undefined;
    if ("client" in clientOrOptions) {
      client = clientOrOptions.client;
      now = clientOrOptions.now;
    } else {
      client = clientOrOptions;
      now = maybeOptions?.now;
    }
    if (!client || client.role !== "brain_app" || typeof client.withRlsTransaction !== "function") {
      throw new Error(
        "PostgresMemoryManager requires a verified AppPostgresClient bound to role 'brain_app'."
      );
    }
    this.runInRlsTransaction = (ctx, cb) => client.withRlsTransaction(ctx, cb);
    this.now = now ?? (() => new Date());
  }

  private resolveRlsContext(ctx: AuthContext, projectId: string): { rlsContext: RlsSessionContext; policiesCsv: string } {
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

  async record(
    ctx: AuthContext,
    input: {
      projectId: string;
      layer: MemoryLayer;
      content: string;
      sessionId?: string;
      accessPolicyId?: string;
      humanApproved?: boolean;
    }
  ): Promise<MemoryEntry> {
    if (input.layer === "organizational" && !input.humanApproved) {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        "Promoção para Organizational Memory exige aprovação humana explícita via PR ou Command Center.",
        403
      );
    }
    if (input.layer === "organizational" && ctx.actorType === "agent") {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        "Agentes nunca podem escrever diretamente na Organizational Memory.",
        403
      );
    }

    const { rlsContext } = this.resolveRlsContext(ctx, input.projectId);
    const accessPolicyId = input.accessPolicyId ?? ctx.allowedPolicies[0] ?? "internal-project";
    if (!ctx.allowedPolicies.includes(accessPolicyId)) {
      throw new BrainError(
        "BRAIN_ERR_POLICY_DENIED",
        `Política de acesso '${accessPolicyId}' não autorizada para o ator '${ctx.actorId}'.`,
        403
      );
    }

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const expiresAtIso =
      input.layer === "working"
        ? new Date(nowDate.getTime() + WORKING_TTL_MS).toISOString()
        : input.layer === "episodic"
          ? new Date(nowDate.getTime() + EPISODIC_TTL_MS).toISOString()
          : null;

    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const rows = await tx<MemoryEntryRow>`INSERT INTO memory_entries (
        tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at
      ) VALUES (
        ${ctx.tenantId},
        ${input.projectId},
        ${input.layer},
        ${input.sessionId ?? null},
        ${input.content},
        ${accessPolicyId},
        ${expiresAtIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      RETURNING id, tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at`;

      const row = rows[0];
      if (!row) {
        throw new Error("Falha ao inserir entrada em memory_entries.");
      }
      return mapMemoryRow(row, ctx.actorId);
    });
  }

  async listVisible(
    ctx: AuthContext,
    projectId: string,
    sessionId?: string,
    now?: Date
  ): Promise<MemoryEntry[]> {
    const { rlsContext, policiesCsv } = this.resolveRlsContext(ctx, projectId);
    const effectiveNow = (now ?? this.now()).toISOString();

    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const rows = await tx<MemoryEntryRow>`SELECT
        id, tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at
      FROM memory_entries
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
        AND (expires_at IS NULL OR expires_at > ${effectiveNow}::timestamptz)
      ORDER BY created_at ASC`;

      return rows
        .map((r) => mapMemoryRow(r, ctx.actorId))
        .filter((e) => !(e.layer === "working" && e.sessionId && sessionId && e.sessionId !== sessionId));
    });
  }

  async compactEpisodicToSemantic(
    ctx: AuthContext,
    projectId: string,
    now?: Date
  ): Promise<{ archivedCount: number; semanticCreated?: MemoryEntry }> {
    const { rlsContext, policiesCsv } = this.resolveRlsContext(ctx, projectId);
    const effectiveDate = now ?? this.now();
    const effectiveNowIso = effectiveDate.toISOString();
    const cutoffIso = new Date(effectiveDate.getTime() - EPISODIC_TTL_MS).toISOString();

    return this.runInRlsTransaction(rlsContext, async (tx) => {
      const staleRows = await tx<MemoryEntryRow>`SELECT
        id, tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at
      FROM memory_entries
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND layer = 'episodic'
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
        AND ((expires_at IS NOT NULL AND expires_at <= ${effectiveNowIso}::timestamptz) OR created_at < ${cutoffIso}::timestamptz)
      ORDER BY created_at ASC`;

      if (staleRows.length === 0) {
        return { archivedCount: 0 };
      }

      const staleIds = staleRows.map((r) => String(r.id));
      await tx`DELETE FROM memory_entries
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND id = ANY(string_to_array(${staleIds.join(",")}, ',')::uuid[])`;

      const consolidatedContent = `Resumo consolidado de ${staleRows.length} memórias episódicas antigas: ${staleRows
        .slice(0, 5)
        .map((s) => String(s.content).slice(0, 80))
        .join(" | ")}`;

      const policyForSemantic = String(staleRows[0]!.access_policy_id);
      const semanticLayer: MemoryLayer = "semantic";
      const inserted = await tx<MemoryEntryRow>`INSERT INTO memory_entries (
        tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at
      ) VALUES (
        ${ctx.tenantId},
        ${projectId},
        ${semanticLayer},
        ${null},
        ${consolidatedContent},
        ${policyForSemantic},
        ${null},
        ${effectiveNowIso}::timestamptz
      )
      RETURNING id, tenant_id, project_id, layer, session_id, content, access_policy_id, expires_at, created_at`;

      const semanticRow = inserted[0];
      return {
        archivedCount: staleRows.length,
        ...(semanticRow ? { semanticCreated: mapMemoryRow(semanticRow, ctx.actorId) } : {})
      };
    });
  }

  async runDecay(
    ctx: AuthContext,
    projectId: string,
    now?: Date
  ): Promise<{ expiredWorkingRemoved: number; archivedCount: number; semanticCreated?: MemoryEntry }> {
    const { rlsContext, policiesCsv } = this.resolveRlsContext(ctx, projectId);
    const effectiveDate = now ?? this.now();
    const effectiveNowIso = effectiveDate.toISOString();

    const expiredWorkingRemoved = await this.runInRlsTransaction(rlsContext, async (tx) => {
      const deleted = await tx<{ id: string }>`DELETE FROM memory_entries
      WHERE tenant_id = ${ctx.tenantId}
        AND project_id = ${projectId}
        AND layer = 'working'
        AND access_policy_id = ANY(string_to_array(${policiesCsv}, ','))
        AND expires_at IS NOT NULL
        AND expires_at <= ${effectiveNowIso}::timestamptz
      RETURNING id`;
      return deleted.length;
    });

    const compacted = await this.compactEpisodicToSemantic(ctx, projectId, effectiveDate);
    return {
      expiredWorkingRemoved,
      archivedCount: compacted.archivedCount,
      ...(compacted.semanticCreated ? { semanticCreated: compacted.semanticCreated } : {})
    };
  }
}

export function createPostgresMemoryManagerForTesting<
  TTx extends MemorySqlTransactionRunner = MemorySqlTransactionRunner
>(sql: RlsSqlClient<TTx>, options?: { now?: () => Date }): PostgresMemoryManager<TTx> {
  const fakeClient: AppPostgresClient<TTx> = {
    role: "brain_app",
    sql: sql as unknown as AppPostgresClient<TTx>["sql"],
    withRlsTransaction: (ctx, cb) => withRlsTransaction(sql, ctx, cb),
    async close() {}
  };
  return new PostgresMemoryManager({ client: fakeClient, now: options?.now });
}

