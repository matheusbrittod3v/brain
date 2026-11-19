import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext } from "@brain/auth";
import { withTenantRls } from "./client.js";
import { PgRunnerHandoffsRepo } from "./operational-repos/runner-handoffs.js";
import type { MemoryLayer } from "./operational-repos/shared.js";
import {
  crossServiceContracts,
  departmentFinopsQuotas,
  developerProfiles,
  knowledgeRelations,
  lgpdShreddedSubjects,
  memoryEntries,
  organizations,
  projects,
  syncChanges,
  syncProjectLocks
} from "./schema.js";

export type { MemoryLayer };

export class PgOperationalRepository extends PgRunnerHandoffsRepo {
  async appendSyncChange(
    ctx: AuthContext,
    input: { projectId: string; itemId: string; contentHash: string; accessPolicyId: string; deletedAt?: Date }
  ): Promise<number> {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(syncProjectLocks).values({
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        lockedAt: new Date()
      }).onConflictDoUpdate({
        target: [syncProjectLocks.tenantId, syncProjectLocks.projectId],
        set: { lockedAt: new Date() }
      });
      const inserted = await tx
        .insert(syncChanges)
        .values({
          tenantId: ctx.tenantId,
          projectId: input.projectId,
          itemId: input.itemId,
          contentHash: input.contentHash,
          accessPolicyId: input.accessPolicyId,
          deletedAt: input.deletedAt ?? null
        })
        .returning({ syncSeq: syncChanges.syncSeq });
      return inserted[0]?.syncSeq ?? 0;
    });
  }

  async pullSyncChanges(ctx: AuthContext, projectId: string, sinceSeq = 0, limit = 100) {
    return withTenantRls(this.db, ctx, async (tx) =>
      tx
        .select()
        .from(syncChanges)
        .where(and(eq(syncChanges.tenantId, ctx.tenantId), eq(syncChanges.projectId, projectId), gt(syncChanges.syncSeq, sinceSeq)))
        .orderBy(asc(syncChanges.syncSeq))
        .limit(limit)
    );
  }

  async getLatestSyncSeq(ctx: AuthContext, projectId: string): Promise<number> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const result = await tx.execute(sql`
        SELECT COALESCE(MAX(sync_seq), 0)::int AS sync_seq
        FROM public.sync_changes
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}
      `);
      return Number(result[0]?.sync_seq ?? 0);
    });
  }

  async appendMemory(
    ctx: AuthContext,
    input: { projectId: string; layer: MemoryLayer; sessionId?: string; content: string; accessPolicyId: string }
  ): Promise<void> {
    const expiresAt =
      input.layer === "working"
        ? new Date(Date.now() + 24 * 60 * 60_000)
        : input.layer === "episodic"
          ? new Date(Date.now() + 60 * 24 * 60 * 60_000)
          : null;
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(memoryEntries).values({
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        actorId: ctx.actorId,
        layer: input.layer,
        sessionId: input.sessionId ?? null,
        content: input.content,
        accessPolicyId: input.accessPolicyId,
        expiresAt
      });
    });
  }

  async runMemoryDecay(
    ctx: AuthContext,
    options?: { coldArchive?: (entries: Array<{ id: string; projectId: string; actorId: string | null; layer: string; content: string; createdAt: Date }>) => Promise<void> }
  ): Promise<{ expiredMemoryRemoved: number; compactedSemanticCreated: number; decayedRelationsRemoved: number; retainedByAccessCount: number }> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60_000);

      const expiredRows = await tx
        .select()
        .from(memoryEntries)
        .where(and(
          eq(memoryEntries.tenantId, ctx.tenantId),
          inArray(memoryEntries.projectId, ctx.allowedProjects),
          inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
          sql`${memoryEntries.expiresAt} IS NOT NULL AND (${memoryEntries.expiresAt} + make_interval(days => LEAST(90, GREATEST(0, ${memoryEntries.hitCount}) * 7))) < ${nowIso}`
        ));

      let compactedSemanticCreated = 0;
      const episodicByGroup = new Map<string, typeof expiredRows>();
      for (const row of expiredRows) {
        if (row.layer !== "episodic") continue;
        const groupKey = `${row.projectId}\u0000${row.accessPolicyId}`;
        const list = episodicByGroup.get(groupKey) ?? [];
        list.push(row);
        episodicByGroup.set(groupKey, list);
      }
      for (const [groupKey, rows] of episodicByGroup.entries()) {
        const [projectId, accessPolicyId] = groupKey.split("\u0000");
        const summary = `Resumo consolidado de ${rows.length} memórias episódicas: ${rows.map((r) => r.content).join(" | ").slice(0, 4000)}`;
        await tx.insert(memoryEntries).values({
          tenantId: ctx.tenantId,
          projectId: projectId!,
          actorId: ctx.actorId,
          layer: "semantic",
          sessionId: null,
          content: summary,
          accessPolicyId: accessPolicyId!,
          expiresAt: null
        });
        compactedSemanticCreated += 1;
      }

      if (expiredRows.length > 0 && options?.coldArchive) {
        await options.coldArchive(
          expiredRows.map((r) => ({
            id: r.id,
            projectId: r.projectId,
            actorId: r.actorId,
            layer: r.layer,
            content: r.content,
            createdAt: r.createdAt
          }))
        );
      }

      const expired = expiredRows.length === 0
        ? []
        : await tx
            .delete(memoryEntries)
            .where(and(
              eq(memoryEntries.tenantId, ctx.tenantId),
              inArray(memoryEntries.projectId, ctx.allowedProjects),
              inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
              sql`${memoryEntries.expiresAt} IS NOT NULL AND (${memoryEntries.expiresAt} + make_interval(days => LEAST(90, GREATEST(0, ${memoryEntries.hitCount}) * 7))) < ${nowIso}`
            ))
            .returning({ id: memoryEntries.id });

      const retainedRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(memoryEntries)
        .where(and(
          eq(memoryEntries.tenantId, ctx.tenantId),
          inArray(memoryEntries.projectId, ctx.allowedProjects),
          inArray(memoryEntries.accessPolicyId, ctx.allowedPolicies),
          lt(memoryEntries.expiresAt, now),
          gt(memoryEntries.hitCount, 0)
        ));

      const decayed = await tx
        .delete(knowledgeRelations)
        .where(
          and(
            eq(knowledgeRelations.tenantId, ctx.tenantId),
            inArray(knowledgeRelations.fromProjectId, ctx.allowedProjects),
            inArray(knowledgeRelations.toProjectId, ctx.allowedProjects),
            inArray(knowledgeRelations.fromPolicyId, ctx.allowedPolicies),
            inArray(knowledgeRelations.toPolicyId, ctx.allowedPolicies),
            eq(knowledgeRelations.isInferred, true),
            lt(knowledgeRelations.createdAt, sixtyDaysAgo),
            sql`NOT EXISTS (
              SELECT 1 FROM knowledge_items ki
              WHERE ki.tenant_id = ${knowledgeRelations.tenantId}
                AND ((ki.project_id = ${knowledgeRelations.fromProjectId} AND ki.id = ${knowledgeRelations.fromItemId})
                  OR (ki.project_id = ${knowledgeRelations.toProjectId} AND ki.id = ${knowledgeRelations.toItemId}))
                AND ki.context_hit_count > 0
                AND (${knowledgeRelations.createdAt} + interval '60 days' + make_interval(days => LEAST(90, ki.context_hit_count * 7))) >= ${nowIso}
            )`
          )
        )
        .returning({ id: knowledgeRelations.id });

      return {
        expiredMemoryRemoved: expired.length,
        compactedSemanticCreated,
        decayedRelationsRemoved: decayed.length,
        retainedByAccessCount: Number(retainedRows[0]?.count ?? 0)
      };
    });
  }

  async getDeveloperProfile(ctx: AuthContext) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(developerProfiles)
        .where(and(eq(developerProfiles.tenantId, ctx.tenantId), eq(developerProfiles.actorId, ctx.actorId)))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        tenantId: row.tenantId,
        actorId: row.actorId,
        preferredPackageManager: row.preferredPackageManager ?? undefined,
        preferredTestLayout: row.preferredTestLayout ?? undefined,
        preferredArchitectureStyle: row.preferredArchitectureStyle ?? undefined,
        codingConventions: row.codingConventions ?? [],
        preferredHarness: row.preferredHarness ?? undefined,
        optInCrossProject: row.optInCrossProject,
        updatedAt: row.updatedAt.toISOString()
      };
    });
  }

  async upsertDeveloperProfile(
    ctx: AuthContext,
    input: {
      preferredPackageManager?: string;
      preferredTestLayout?: string;
      preferredArchitectureStyle?: string;
      codingConventions?: string[];
      preferredHarness?: string;
      optInCrossProject?: boolean;
    }
  ) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(developerProfiles)
        .values({
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          preferredPackageManager: input.preferredPackageManager ?? null,
          preferredTestLayout: input.preferredTestLayout ?? null,
          preferredArchitectureStyle: input.preferredArchitectureStyle ?? null,
          codingConventions: input.codingConventions ?? [],
          preferredHarness: input.preferredHarness ?? null,
          optInCrossProject: input.optInCrossProject ?? true,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [developerProfiles.tenantId, developerProfiles.actorId],
          set: {
            preferredPackageManager: input.preferredPackageManager ?? null,
            preferredTestLayout: input.preferredTestLayout ?? null,
            preferredArchitectureStyle: input.preferredArchitectureStyle ?? null,
            codingConventions: input.codingConventions ?? [],
            preferredHarness: input.preferredHarness ?? null,
            optInCrossProject: input.optInCrossProject ?? true,
            updatedAt: now
          }
        })
        .returning();
      return {
        tenantId: row!.tenantId,
        actorId: row!.actorId,
        preferredPackageManager: row!.preferredPackageManager ?? undefined,
        preferredTestLayout: row!.preferredTestLayout ?? undefined,
        preferredArchitectureStyle: row!.preferredArchitectureStyle ?? undefined,
        codingConventions: row!.codingConventions ?? [],
        preferredHarness: row!.preferredHarness ?? undefined,
        optInCrossProject: row!.optInCrossProject,
        updatedAt: row!.updatedAt.toISOString()
      };
    });
  }

  async deleteDeveloperProfile(ctx: AuthContext): Promise<boolean> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx
        .delete(developerProfiles)
        .where(and(eq(developerProfiles.tenantId, ctx.tenantId), eq(developerProfiles.actorId, ctx.actorId)))
        .returning({ id: developerProfiles.id });
      return deleted.length > 0;
    });
  }

  async saveCrossServiceContract(
    ctx: AuthContext,
    edge: {
      fromProjectId: string;
      fromService: string;
      relation: string;
      toProjectId: string;
      contractId: string;
      schemaVersion: string;
      accessPolicyId: string;
    }
  ): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx.insert(crossServiceContracts).values({
        tenantId: ctx.tenantId,
        ...edge
      });
    });
  }

  async listDepartmentFinopsQuotas(ctx: AuthContext, projectId: string) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(departmentFinopsQuotas)
        .where(and(eq(departmentFinopsQuotas.tenantId, ctx.tenantId), eq(departmentFinopsQuotas.projectId, projectId)))
        .orderBy(asc(departmentFinopsQuotas.department));
      return rows.map((row) => ({
        department: row.department,
        monthlyTokenLimit: row.monthlyTokenLimit,
        monthlyUsdLimit: Number(row.monthlyUsdLimit),
        downgradeModel: row.downgradeModel ?? undefined,
        updatedAt: row.updatedAt.toISOString()
      }));
    });
  }

  async upsertDepartmentFinopsQuota(
    ctx: AuthContext,
    projectId: string,
    input: { department: string; monthlyTokenLimit: number; monthlyUsdLimit: number; downgradeModel?: string }
  ) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const now = new Date();
      const [row] = await tx
        .insert(departmentFinopsQuotas)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          department: input.department,
          monthlyTokenLimit: input.monthlyTokenLimit,
          monthlyUsdLimit: String(input.monthlyUsdLimit),
          downgradeModel: input.downgradeModel ?? null,
          accessPolicyId: "internal-project",
          updatedBy: ctx.actorId,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [departmentFinopsQuotas.tenantId, departmentFinopsQuotas.projectId, departmentFinopsQuotas.department],
          set: {
            monthlyTokenLimit: input.monthlyTokenLimit,
            monthlyUsdLimit: String(input.monthlyUsdLimit),
            downgradeModel: input.downgradeModel ?? null,
            updatedBy: ctx.actorId,
            updatedAt: now
          }
        })
        .returning();
      return {
        department: row!.department,
        monthlyTokenLimit: row!.monthlyTokenLimit,
        monthlyUsdLimit: Number(row!.monthlyUsdLimit),
        downgradeModel: row!.downgradeModel ?? undefined,
        updatedAt: row!.updatedAt.toISOString()
      };
    });
  }

  async recordLgpdShreddedSubject(ctx: AuthContext, projectId: string, subjectId: string): Promise<void> {
    await withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(lgpdShreddedSubjects)
        .values({
          tenantId: ctx.tenantId,
          projectId,
          subjectId,
          accessPolicyId: "internal-project",
          shreddedBy: ctx.actorId
        })
        .onConflictDoUpdate({
          target: [lgpdShreddedSubjects.tenantId, lgpdShreddedSubjects.projectId, lgpdShreddedSubjects.subjectId],
          set: { shreddedBy: ctx.actorId, shreddedAt: new Date() }
        });
    });
  }

  async isLgpdSubjectShredded(ctx: AuthContext, projectId: string, subjectId: string): Promise<boolean> {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select({ subjectId: lgpdShreddedSubjects.subjectId })
        .from(lgpdShreddedSubjects)
        .where(and(
          eq(lgpdShreddedSubjects.tenantId, ctx.tenantId),
          eq(lgpdShreddedSubjects.projectId, projectId),
          eq(lgpdShreddedSubjects.subjectId, subjectId)
        ))
        .limit(1);
      return rows.length > 0;
    });
  }

  async listProjects(ctx: AuthContext) {
    return withTenantRls(this.db, ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(projects)
        .where(eq(projects.tenantId, ctx.tenantId))
        .orderBy(asc(projects.id));
      return rows.map((row) => ({
        projectId: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description ?? undefined,
        knowledgeRoot: row.knowledgeRoot,
        createdAt: row.createdAt.toISOString()
      }));
    });
  }

  async registerProject(
    ctx: AuthContext,
    input: { projectId: string; name: string; description?: string; knowledgeRoot?: string }
  ) {
    return withTenantRls(this.db, ctx, async (tx) => {
      await tx
        .insert(organizations)
        .values({ id: ctx.tenantId, name: ctx.tenantId })
        .onConflictDoNothing();

      const existing = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.tenantId, ctx.tenantId), eq(projects.id, input.projectId)))
        .limit(1);

      if (existing[0]) {
        const [updated] = await tx
          .update(projects)
          .set({
            name: input.name,
            description: input.description ?? existing[0].description,
            knowledgeRoot: input.knowledgeRoot ?? existing[0].knowledgeRoot
          })
          .where(and(eq(projects.tenantId, ctx.tenantId), eq(projects.id, input.projectId)))
          .returning();
        return {
          created: false,
          project: {
            projectId: updated!.id,
            tenantId: updated!.tenantId,
            name: updated!.name,
            description: updated!.description ?? undefined,
            knowledgeRoot: updated!.knowledgeRoot,
            createdAt: updated!.createdAt.toISOString()
          }
        };
      }

      const [inserted] = await tx
        .insert(projects)
        .values({
          id: input.projectId,
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          knowledgeRoot: input.knowledgeRoot ?? ".brain/"
        })
        .returning();

      return {
        created: true,
        project: {
          projectId: inserted!.id,
          tenantId: inserted!.tenantId,
          name: inserted!.name,
          description: inserted!.description ?? undefined,
          knowledgeRoot: inserted!.knowledgeRoot,
          createdAt: inserted!.createdAt.toISOString()
        }
      };
    });
  }
}

export const HNSW_UPGRADE_INDEX_SQL = sql.raw(
  `CREATE INDEX IF NOT EXISTS idx_ke_embedding_hnsw ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);`
);
