import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@brain/auth";
import type { ContextEngine, IntentType } from "@brain/context-engine";
import type { KnowledgeItem } from "@brain/core";
import { extractCodeAnchors } from "@brain/code-intelligence";
import type { PgOperationalRepository } from "@brain/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import { scanForSecrets } from "@brain/ingestion";
import { parseKnowledgeFile } from "@brain/knowledge";
import type { PostgresMemoryManager } from "@brain/memory";
import type { AsyncRetrievalEngine } from "@brain/retrieval";
import { enqueueEmbedJob, type OllamaEmbeddingProviderStatus } from "@brain/worker";
import { hashWorkspaceSources } from "@brain/workspace-detection";
import { assertSecretScanClean, redactPiiWithAiWorker } from "../services/ai-worker.js";
import { configuredWorkspaceRoot } from "../services/jobs.js";

export function registerIngestContextRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    probeEmbeddingProvider: () => Promise<OllamaEmbeddingProviderStatus>;
    getDeveloperProfile: (ctx: AuthContext) => Promise<{ optInCrossProject?: boolean } | undefined>;
    graph: KnowledgeGraphStore;
    pgGraph?: PostgresGraphStore;
    contextEngine: ContextEngine<AsyncRetrievalEngine>;
    pgMemory?: PostgresMemoryManager;
    opRepo?: PgOperationalRepository;
  }
) {
  const {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    upsertKnowledgeItem,
    probeEmbeddingProvider,
    getDeveloperProfile,
    graph,
    pgGraph,
    contextEngine,
    pgMemory,
    opRepo
  } = deps;

  app.post<{ Params: { projectId: string }; Body: { filePath: string; content: string; commitSha?: string } }>(
    "/v1/projects/:projectId/ingest",
    {
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({ filePath: Type.String(), content: Type.String(), commitSha: Type.Optional(Type.String()) })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const scan = scanForSecrets(req.body.content, { ignoreFilePath: ".brainignore-secrets" });
      assertSecretScanClean(scan, "Segredo detectado na ingestão");
      const sanitizedContent = await redactPiiWithAiWorker(req.body.content);
      const piiRedacted = sanitizedContent !== req.body.content;
      if (scan.ignoredFindings.length > 0) {
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: "internal-project",
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "brainignore_secrets",
          targetId: req.body.filePath,
          metadata: { ignoredFindings: scan.ignoredFindings }
        });
      }

      const item = parseKnowledgeFile({
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        filePath: req.body.filePath,
        rawContent: sanitizedContent,
        commitSha: req.body.commitSha
      });
      assertPolicyAccess(ctx, item.accessPolicyId);
      await enforceOpa(ctx, {
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        action: "write",
        domainId: item.domainId
      });
      await upsertKnowledgeItem(ctx, item);

      const anchors = extractCodeAnchors(req.body.filePath, sanitizedContent);
      for (const anchor of anchors) {
        const edge = {
          tenantId: ctx.tenantId,
          fromProjectId: req.params.projectId,
          toProjectId: req.params.projectId,
          fromItemId: item.id,
          toItemId: anchor.targetId,
          fromPolicyId: item.accessPolicyId,
          toPolicyId: item.accessPolicyId,
          relationType: anchor.relationType,
          isInferred: false as const,
          confidence: 1.0
        };
        graph.addEdge(edge);
        if (pgGraph) await pgGraph.addEdge(ctx, edge);
      }

      const isTestItem = item.type === "test" || item.id.startsWith("TEST-") || /\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(item.sourceUri);
      for (const targetId of item.relatedIds ?? []) {
        if (!targetId || targetId === item.id) continue;
        const targetIsTest = targetId.startsWith("TEST-");
        const edge = isTestItem
          ? {
              tenantId: ctx.tenantId,
              fromProjectId: req.params.projectId,
              toProjectId: req.params.projectId,
              fromItemId: targetId,
              toItemId: item.id,
              fromPolicyId: item.accessPolicyId,
              toPolicyId: item.accessPolicyId,
              relationType: "VERIFIED_BY" as const,
              isInferred: false as const,
              confidence: 1.0
            }
          : {
              tenantId: ctx.tenantId,
              fromProjectId: req.params.projectId,
              toProjectId: req.params.projectId,
              fromItemId: item.id,
              toItemId: targetId,
              fromPolicyId: item.accessPolicyId,
              toPolicyId: item.accessPolicyId,
              relationType: targetIsTest ? ("VERIFIED_BY" as const) : ("DEPENDS_ON" as const),
              isInferred: false as const,
              confidence: 1.0
            };
        graph.addEdge(edge);
        if (pgGraph) await pgGraph.addEdge(ctx, edge);
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: item.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { piiRedacted }
      });

      const warnings: string[] = [];
      if (piiRedacted) warnings.push("Dados pessoais foram sanitizados pelo AI Worker antes da indexação.");
      if (process.env.BRAIN_PG_BOSS === "1" && process.env.DATABASE_URL) {
        const embeddingProvider = await probeEmbeddingProvider();
        if (!embeddingProvider.available) {
          const reason = embeddingProvider.reason === "model_missing" ? "o modelo configurado não está instalado" : "o provedor não está acessível";
          warnings.push(`Embeddings vetoriais não foram enfileirados: ${reason}; o item permanece disponível para busca textual.`);
        } else {
          try {
            const jobId = await enqueueEmbedJob({
              tenantId: ctx.tenantId,
              projectId: req.params.projectId,
              itemId: item.id,
              sourceVersion: item.sourceVersion,
              accessPolicyId: item.accessPolicyId,
              content: item.content
            });
            if (!jobId) warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
          } catch {
            warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
          }
        }
      } else {
        warnings.push("Embeddings vetoriais não foram enfileirados porque o worker pg-boss não está configurado; o item permanece disponível para busca textual.");
      }

      return { ingested: true, id: item.id, anchorsCount: anchors.length, warnings };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { task: string; intent?: IntentType; includeDomains?: number[]; tokenBudget?: number; explain?: boolean; sessionId?: string; taskId?: string };
  }>(
    "/v1/projects/:projectId/context",
    {
      schema: {
        body: Type.Object({
          task: Type.String(),
          intent: Type.Optional(Type.String()),
          includeDomains: Type.Optional(Type.Array(Type.Number())),
          tokenBudget: Type.Optional(Type.Number()),
          explain: Type.Optional(Type.Boolean()),
          sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          taskId: Type.Optional(Type.String())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const sessionId = req.body.sessionId ?? randomUUID();
      const pack = await contextEngine.buildContextPack(ctx, {
        projectId: req.params.projectId,
        task: req.body.task,
        intent: req.body.intent,
        includeDomains: req.body.includeDomains,
        tokenBudget: req.body.tokenBudget,
        explain: req.body.explain,
        sessionId,
        memories: pgMemory ? await pgMemory.listVisible(ctx, req.params.projectId, sessionId) : []
      });
      const sourceHashes = await hashWorkspaceSources(
        configuredWorkspaceRoot(req.params.projectId),
        pack.sources.map((source) => source.sourceUri)
      );
      const hashByUri = new Map(sourceHashes.map((source) => [source.sourceUri, source.sourceHash]));
      const rate = opRepo
        ? await opRepo.recordContextDelivery(
            ctx,
            req.params.projectId,
            sessionId,
            pack.sources.map((source) => ({
              itemId: source.id,
              accessPolicyId: source.accessPolicyId,
              sourceUri: source.sourceUri,
              sourceHash: hashByUri.get(source.sourceUri),
              taskId: req.body.taskId
            }))
          )
        : { sessionId, hits: 0, itemsSent: pack.sources.length, rate: null };
      const devProfile = await getDeveloperProfile(ctx);
      return {
        ...pack,
        sessionId,
        hitRate: rate,
        ...(devProfile?.optInCrossProject ? { developerProfile: devProfile } : {})
      };
    }
  );
}
