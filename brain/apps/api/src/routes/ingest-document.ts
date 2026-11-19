import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import { scanForSecrets } from "@brain/ingestion";
import { parseKnowledgeFile } from "@brain/knowledge";
import { enqueueEmbedJob, type OllamaEmbeddingProviderStatus } from "@brain/worker";
import {
  assertSecretScanClean,
  DOCUMENT_EXTENSIONS,
  MAX_DOCUMENT_BASE64_CHARS,
  MAX_DOCUMENT_BYTES,
  parseDocumentWithAiWorker,
  redactPiiWithAiWorker
} from "../services/ai-worker.js";
import { uploadObjectToMinio } from "../services/minio-storage.js";

export function registerIngestDocumentRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforcePolicy: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
    probeEmbeddingProvider: () => Promise<OllamaEmbeddingProviderStatus>;
  }
) {
  const { authenticateProjectRequest, enforcePolicy, recordAudit, upsertKnowledgeItem, probeEmbeddingProvider } = deps;

  app.post<{
    Params: { projectId: string };
    Body: { fileName: string; contentBase64: string; accessPolicyId?: string };
  }>(
    "/v1/projects/:projectId/ingest-document",
    {
      bodyLimit: 24 * 1024 * 1024,
      schema: {
        params: Type.Object({ projectId: Type.String() }),
        body: Type.Object({
          fileName: Type.String({ minLength: 1, maxLength: 255 }),
          contentBase64: Type.String({ minLength: 1, maxLength: MAX_DOCUMENT_BASE64_CHARS }),
          accessPolicyId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 }))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const { fileName, contentBase64 } = req.body;
      if (fileName !== fileName.trim() || /[/\\\0\r\n]/.test(fileName)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "fileName deve ser apenas um nome de arquivo, sem caminho.", 422);
      }
      const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
      if (!DOCUMENT_EXTENSIONS.has(extension)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Formato não suportado. Use PDF, DOCX, PPTX, XLSX, HTML ou CSV.", 422);
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "contentBase64 inválido.", 422);
      }
      const sourceBytes = Buffer.from(contentBase64, "base64");
      if (sourceBytes.length === 0 || sourceBytes.length > MAX_DOCUMENT_BYTES || sourceBytes.toString("base64") !== contentBase64) {
        throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Documento vazio ou acima do limite de 16 MiB.", 422);
      }
      const policy = req.body.accessPolicyId ?? "internal-project";
      assertPolicyAccess(ctx, policy);

      const parsedDocument = await parseDocumentWithAiWorker(fileName, contentBase64);
      const extractedMarkdown = parsedDocument.markdown;
      const scan = scanForSecrets(extractedMarkdown, { ignoreFilePath: ".brainignore-secrets" });
      assertSecretScanClean(scan, "Segredo detectado no documento extraído");
      const sanitizedMarkdown = await redactPiiWithAiWorker(extractedMarkdown);
      const piiRedacted = sanitizedMarkdown !== extractedMarkdown;
      const normalizedName = fileName.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^\.+/, "");
      const sourceUri = `.brain/imported-documents/${normalizedName}.md`;
      const rawContent = [
        "---",
        `id: ${JSON.stringify(sourceUri)}`,
        `title: ${JSON.stringify(fileName)}`,
        "type: document",
        "status: draft",
        "trust_level: untrusted",
        `access_policy: ${JSON.stringify(policy)}`,
        "---",
        "",
        sanitizedMarkdown
      ].join("\n");
      const item = parseKnowledgeFile({ tenantId: ctx.tenantId, projectId: req.params.projectId, filePath: sourceUri, rawContent });
      item.sourceOrigin = "external_reference";
      item.sourceKind = "api";
      item.trustLevel = "untrusted";
      const minioObj = await uploadObjectToMinio({
        key: `${ctx.tenantId}/${req.params.projectId}/documents/${Date.now()}-${normalizedName}`,
        body: sourceBytes,
        contentType: "application/octet-stream"
      });
      const syncedAt = new Date().toISOString();
      item.metadata = {
        ...item.metadata,
        source: "document_upload",
        originalFileName: fileName,
        extractionEngine: parsedDocument.engine,
        syncedAt,
        sourceVersion: item.sourceVersion,
        sizeBytes: sourceBytes.length,
        ...(minioObj.uploaded
          ? {
              minioUri: minioObj.uri,
              minioBucket: minioObj.bucket,
              minioObjectKey: minioObj.key
            }
          : {})
      };
      assertPolicyAccess(ctx, item.accessPolicyId);
      await enforcePolicy(ctx, { projectId: req.params.projectId, accessPolicyId: item.accessPolicyId, action: "write", domainId: item.domainId });
      await upsertKnowledgeItem(ctx, item);
      if (scan.ignoredFindings.length > 0) {
        await recordAudit(ctx, {
          tenantId: ctx.tenantId,
          projectId: req.params.projectId,
          accessPolicyId: item.accessPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "update",
          targetType: "brainignore_secrets",
          targetId: sourceUri,
          metadata: { ignoredFindings: scan.ignoredFindings }
        });
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
        metadata: { source: "document_ingest", originalFileName: fileName, piiRedacted, extractionEngine: parsedDocument.engine }
      });

      const warnings: string[] = [];
      if (piiRedacted) warnings.push("Dados pessoais foram sanitizados pelo AI Worker antes da indexação.");
      if (process.env.BRAIN_PG_BOSS === "1" && process.env.DATABASE_URL) {
        const embeddingProvider = await probeEmbeddingProvider();
        if (embeddingProvider.available) {
          try {
            const jobId = await enqueueEmbedJob({
              tenantId: item.tenantId,
              projectId: item.projectId,
              itemId: item.id,
              sourceVersion: item.sourceVersion,
              accessPolicyId: item.accessPolicyId,
              content: item.content
            });
            if (!jobId) warnings.push("Embeddings não foram enfileirados; o item permanece disponível para busca textual.");
          } catch {
            warnings.push("Embeddings não foram enfileirados; o item permanece disponível para busca textual.");
          }
        } else warnings.push("Embeddings vetoriais não foram enfileirados; o item permanece disponível para busca textual.");
      } else warnings.push("Embeddings vetoriais não foram enfileirados porque o worker pg-boss não está configurado; o item permanece disponível para busca textual.");
      return { item, piiRedacted, warnings };
    }
  );
}
