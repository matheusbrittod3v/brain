import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { assertPolicyAccess, assertProjectAccess, authenticateRequest, enforceOpaPolicy, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import type { PgOperationalRepository } from "@brain/database";
import { buildBusinessRuleTestCoverageMatrix, buildTechRadar } from "@brain/enterprise-views";
import { privacyEraseSubject, type SystemKnowledgeSqlClient } from "@brain/knowledge";
import type { PostgresRetrievalEngine } from "@brain/retrieval";
import { eraseMinioObjectsForSubject } from "../services/minio-storage.js";
import type { PgTemporalKnowledgeRepository, TemporalKnowledgeEngine } from "@brain/temporal-knowledge";

export function registerPrivacyEnterpriseRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: KnowledgeItem }>> };
    projectVerifiedTests: (ctx: AuthContext, projectId: string, items: KnowledgeItem[]) => Promise<any>;
    projectHealth: (items: KnowledgeItem[], verifiedTests: any, linkedTestsByRule?: Map<string, string[]>) => any;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    systemKnowledgeClient?: SystemKnowledgeSqlClient;
    pgRetrieval?: PostgresRetrievalEngine;
    opRepo?: PgOperationalRepository;
    pgTemporal?: PgTemporalKnowledgeRepository;
    temporal: TemporalKnowledgeEngine;
    pgCrossService?: PostgresCrossServiceRegistry;
    crossService: CrossServiceContractRegistry;
    shreddedSubjectKeys: Set<string>;
  }
) {
  const {
    authenticateProjectRequest,
    recordAudit,
    queryAwareRetrieval,
    projectVerifiedTests,
    projectHealth,
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    systemKnowledgeClient,
    pgRetrieval,
    opRepo,
    pgTemporal,
    temporal,
    pgCrossService,
    crossService,
    shreddedSubjectKeys
  } = deps;

  app.post<{ Body: { subjectId: string; projectId: string } }>("/v1/privacy/erase", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.body.projectId);
    await enforceOpaPolicy(ctx, { projectId: req.body.projectId, accessPolicyId: "internal-project", action: "write" });
    if (!systemKnowledgeClient || process.env.BRAIN_PG_STORES !== "1") {
      throw new BrainError(
        "BRAIN_ERR_STORAGE_UNAVAILABLE",
        "Privacy erase exige DATABASE_SYSTEM_URL com a role brain_system e armazenamento PostgreSQL ativo; nenhum registro foi alterado.",
        503
      );
    }
    const explicitS3Keys: string[] = [];
    try {
      const bucket = process.env.MINIO_BUCKET ?? "brain-artifacts";
      const s3UriRegex = new RegExp(`s3://${bucket}/([^\\s"'\\)]+)`, "gi");
      const pattern = `%${req.body.subjectId}%`;
      const collectS3Keys = (raw: string) => {
        let m: RegExpExecArray | null;
        while ((m = s3UriRegex.exec(raw)) !== null) {
          if (m[1]) explicitS3Keys.push(m[1]);
        }
      };
      const runFind = async (runner: { (strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): PromiseLike<unknown> }) =>
        runner`
          SELECT source_uri, content, metadata::text AS meta_text
          FROM knowledge_items
          WHERE tenant_id = ${ctx.tenantId}
            AND project_id = ${req.body.projectId}
            AND (owner_id = ${req.body.subjectId} OR content ILIKE ${pattern} OR source_uri ILIKE ${pattern} OR metadata::text ILIKE ${pattern})
        `;
      const matchedItems = ("begin" in systemKnowledgeClient && typeof systemKnowledgeClient.begin === "function"
        ? await systemKnowledgeClient.begin((tx) => runFind(tx))
        : await runFind(systemKnowledgeClient as unknown as Parameters<typeof runFind>[0])) as Array<{ source_uri?: string; content?: string; meta_text?: string }>;
      for (const row of matchedItems ?? []) {
        if (row.source_uri) collectS3Keys(row.source_uri);
        if (row.content) collectS3Keys(row.content);
        if (row.meta_text) collectS3Keys(row.meta_text);
      }
    } catch {
      // ignore extraction errors; MinIO content scan still runs
    }

    const erased = await privacyEraseSubject(systemKnowledgeClient, {
      tenantId: ctx.tenantId,
      subjectId: req.body.subjectId,
      projectId: req.body.projectId
    });
    const deletedFromPg = erased.deletedItems;
    pgRetrieval?.invalidateCache(ctx.tenantId, req.body.projectId);

    const subjectKeyId = `${ctx.tenantId}:${req.body.projectId}:${req.body.subjectId}`;
    shreddedSubjectKeys.add(subjectKeyId);
    if (opRepo) await opRepo.recordLgpdShreddedSubject(ctx, req.body.projectId, req.body.subjectId);
    const cryptoShredded = true;

    const anonymizedActorId = `anon:${createHash("sha256").update(subjectKeyId).digest("hex").slice(0, 16)}`;
    let auditLogsAnonymized = 0;
    try {
      const runUpdate = async (runner: { (strings: TemplateStringsArray, ...values: Array<string | number | boolean | null>): PromiseLike<unknown> }) =>
        runner`
          UPDATE audit_logs
          SET actor_id = ${anonymizedActorId}
          WHERE tenant_id = ${ctx.tenantId} AND project_id = ${req.body.projectId} AND actor_id = ${req.body.subjectId}
          RETURNING id
        `;
      const anonRes = ("begin" in systemKnowledgeClient && typeof systemKnowledgeClient.begin === "function"
        ? await systemKnowledgeClient.begin((tx) => runUpdate(tx))
        : await runUpdate(systemKnowledgeClient as unknown as Parameters<typeof runUpdate>[0])) as unknown[];
      auditLogsAnonymized = Array.isArray(anonRes) ? anonRes.length : 0;
    } catch {
      auditLogsAnonymized = 0;
    }

    const minioConfigured = Boolean(process.env.MINIO_ENDPOINT || process.env.BRAIN_OBJECT_STORAGE_URL);
    const minioResult = await eraseMinioObjectsForSubject({
      tenantId: ctx.tenantId,
      projectId: req.body.projectId,
      subjectId: req.body.subjectId,
      explicitKeys: explicitS3Keys,
      endpoint: process.env.BRAIN_OBJECT_STORAGE_URL ?? process.env.MINIO_ENDPOINT
    });

    const objectStorageDeleted = minioResult.reachable && minioResult.ok;
    const objectStorageStatus: "deleted" | "not_configured" | "failed" = minioResult.reachable
      ? minioResult.ok
        ? "deleted"
        : "failed"
      : minioConfigured
        ? "failed"
        : "not_configured";

    const complete = cryptoShredded && objectStorageStatus === "deleted";
    const limitations: string[] = [];
    if (objectStorageStatus === "not_configured") {
      limitations.push("MinIO/Object Storage inacessível ou não configurado neste ambiente; exclusão de objetos binários não confirmada.");
    } else if (objectStorageStatus === "failed") {
      limitations.push(`Falha ao remover objetos do MinIO/Object Storage (${minioResult.failedCount} falha(s)).`);
    }
    if (erased.createdSyncTombstones > 0) {
      limitations.push("Cópias Edge serão removidas após sincronização do tombstone");
    }

    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.body.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "revoke",
      targetType: "privacy_erase",
      targetId: createHash("sha256").update(subjectKeyId).digest("hex"),
      metadata: {
        deletedFromPg,
        deletedVersions: erased.deletedVersions,
        deletedEmbeddings: erased.deletedEmbeddings,
        deletedRelations: erased.deletedRelations,
        createdSyncTombstones: erased.createdSyncTombstones,
        deletedMemories: erased.deletedMemories,
        deletedHandoffs: erased.deletedHandoffs,
        deletedRunnerQuestions: erased.deletedRunnerQuestions,
        deletedRunnerTasks: erased.deletedRunnerTasks,
        deletedTaskLeases: erased.deletedTaskLeases,
        canonicalKnowledgeRecordsDeleted: true,
        cryptoShredded,
        auditLogsAnonymized,
        objectStorageDeleted,
        objectStorageStatus,
        offlineCopiesInvalidated: erased.createdSyncTombstones > 0
      }
    });
    return {
      erased: true,
      deletedFromPg,
      deletedVersions: erased.deletedVersions,
      deletedEmbeddings: erased.deletedEmbeddings,
      deletedRelations: erased.deletedRelations,
      createdSyncTombstones: erased.createdSyncTombstones,
      deletedMemories: erased.deletedMemories,
      deletedHandoffs: erased.deletedHandoffs,
      deletedRunnerQuestions: erased.deletedRunnerQuestions,
      deletedRunnerTasks: erased.deletedRunnerTasks,
      deletedTaskLeases: erased.deletedTaskLeases,
      cryptoShredded,
      auditLogsAnonymized,
      objectStorageDeleted,
      objectStorageStatus,
      matchedMinioObjects: minioResult.matchedCount,
      deletedMinioObjects: minioResult.deletedCount,
      complete,
      limitations
    };
  });

  app.post<{ Params: { projectId: string }; Body: { atTimestamp?: string; commitSha?: string } }>(
    "/v1/projects/:projectId/temporal/query",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (pgTemporal) return { items: await pgTemporal.queryVersionsAt(ctx, { projectId: req.params.projectId, ...req.body }) };
      return { items: temporal.queryAt(ctx, { projectId: req.params.projectId, ...req.body }) };
    }
  );

  app.post<{
    Body: {
      fromProjectId: string;
      fromService: string;
      relation: "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO";
      toProjectId: string;
      contractId: string;
      schemaVersion?: string;
      accessPolicyId?: string;
    };
  }>("/v1/cross-service/contracts", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    assertProjectAccess(ctx, req.body.fromProjectId);
    assertProjectAccess(ctx, req.body.toProjectId);
    const accessPolicyId = req.body.accessPolicyId ?? "internal-project";
    assertPolicyAccess(ctx, accessPolicyId);
    const edge = {
      tenantId: ctx.tenantId,
      fromProjectId: req.body.fromProjectId,
      fromService: req.body.fromService,
      relation: req.body.relation,
      toProjectId: req.body.toProjectId,
      contractId: req.body.contractId,
      schemaVersion: req.body.schemaVersion ?? "1.0.0",
      accessPolicyId
    };
    if (pgCrossService) await pgCrossService.registerContract(edge, ctx);
    else crossService.registerContract(edge);
    return { registered: true, edge };
  });

  app.post<{ Body: { contractId: string } }>("/v1/cross-service/blast-radius", async (req) => {
    const ctx = await authenticateRequest(req.headers.authorization, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    if (pgCrossService) return pgCrossService.computeDistributedBlastRadius(ctx, req.body.contractId);
    return crossService.computeDistributedBlastRadius(ctx, req.body.contractId);
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/enterprise/views", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 100 });
    const items = hits.map((h) => h.item);
    const evidence = await projectVerifiedTests(ctx, req.params.projectId, items);
    const verifiedTests = evidence.verifiedTests;
    const qaCoverage = buildBusinessRuleTestCoverageMatrix(items, [], {
      linkedTestsByRule: evidence.linkedTestsByRule,
      testItemsById: evidence.testItemsById,
      requireMainHead: evidence.requireMainHead,
      requireRepositoryAssociation: evidence.requireRepositoryAssociation,
      mainHeadByRepository: evidence.mainHeadByRepository,
      testResults: evidence.testExecutionResults
    });
    return {
      techRadar: buildTechRadar(items),
      qaCoverage,
      testExecutionResults: evidence.testExecutionResults,
      health: projectHealth(items, verifiedTests, evidence.linkedTestsByRule)
    };
  });
}

