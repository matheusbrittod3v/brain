import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { assertPolicyAccess, assertProjectAccess, authenticateRequest, buildAbilityForContext, subject, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import type { PgOperationalRepository } from "@brain/database";
import { buildBusinessRuleTestCoverageMatrix, buildTechRadar } from "@brain/enterprise-views";
import { privacyEraseSubject, type SystemKnowledgeSqlClient } from "@brain/knowledge";
import type { PostgresRetrievalEngine } from "@brain/retrieval";
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
    const ability = buildAbilityForContext(ctx);
    const opaAllowed = ability.can("write", subject("Knowledge", { projectId: req.body.projectId, accessPolicyId: "internal-project" }));
    if (!opaAllowed) throw new BrainError("BRAIN_ERR_POLICY_DENIED", "CASL negou operação de privacy erase.", 403);
    if (!systemKnowledgeClient || process.env.BRAIN_PG_STORES !== "1") {
      throw new BrainError(
        "BRAIN_ERR_STORAGE_UNAVAILABLE",
        "Privacy erase exige DATABASE_SYSTEM_URL com a role brain_system e armazenamento PostgreSQL ativo; nenhum registro foi alterado.",
        503
      );
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

    const objectStorageUrl = process.env.BRAIN_OBJECT_STORAGE_URL ?? process.env.MINIO_ENDPOINT;
    let objectStorageDeleted = false;
    let objectStorageStatus: "deleted" | "not_configured" | "failed" = "not_configured";
    if (objectStorageUrl) {
      try {
        const res = await fetch(`${objectStorageUrl.replace(/\/$/, "")}/privacy/erase`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: ctx.tenantId, projectId: req.body.projectId, subjectId: req.body.subjectId })
        });
        objectStorageDeleted = res.ok;
        objectStorageStatus = res.ok ? "deleted" : "failed";
      } catch {
        objectStorageDeleted = false;
        objectStorageStatus = "failed";
      }
    }

    const complete = cryptoShredded && objectStorageStatus !== "failed";
    const limitations: string[] = [];
    if (objectStorageStatus === "not_configured") {
      limitations.push("MinIO/Object Storage não configurado neste ambiente (nenhum bucket externo ativo)");
    } else if (objectStorageStatus === "failed") {
      limitations.push("Falha ao remover objetos do MinIO/Object Storage");
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

