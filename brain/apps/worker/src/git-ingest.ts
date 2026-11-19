import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { AuthContext } from "@brain/auth";
import { extractCodeAnchors, extractScipDocumentRelationships, extractScipSymbols, parseScipIndex, type ScipIndex } from "@brain/code-intelligence";
import type { KnowledgeItem } from "@brain/core";
import type { DbAuditEvent, PgKnowledgeRepository, PgOperationalRepository } from "@brain/database";
import type { RelationType } from "@brain/graph";
import {
  chunkCodeByAst,
  chunkMarkdown,
  createGitHubAppJwt,
  exchangeInstallationToken,
  fetchRepoCommitChanges,
  fetchRepoTreeAndFiles,
  scanForSecrets,
  type SecretScanResult,
  type TextChunk
} from "@brain/ingestion";
import { parseKnowledgeFile, type KnowledgeRepository } from "@brain/knowledge";
import { fetchOllamaEmbedding, WorkerAuditWriteError, type EmbedJobPayload } from "./embeddings.js";

export interface GitIngestJobPayload {
  tenantId: string;
  projectId: string;
  repoDir?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  commitSha?: string;
  beforeCommitSha?: string;
  branch?: string;
  accessPolicyId?: string;
}

export type WorkerKnowledgeRepo = Omit<Pick<PgKnowledgeRepository, "upsertItem">, "upsertItem"> & {
  upsertItem(ctx: AuthContext, item: KnowledgeItem): Promise<{ version: number; changed: boolean; sourceVersion?: string }>;
} &
  Partial<Pick<PgKnowledgeRepository, "upsertEmbedding">> & {
    replaceItemEmbeddings?: KnowledgeRepository["replaceItemEmbeddings"];
  };

export interface WorkerGraphEdgeInput {
  tenantId: string;
  fromProjectId: string;
  toProjectId: string;
  fromItemId: string;
  toItemId: string;
  fromPolicyId: string;
  toPolicyId: string;
  relationType: RelationType;
  isInferred: boolean;
  confidence: number;
  evidenceUri?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerGraphStore {
  addEdge(edge: WorkerGraphEdgeInput): Promise<unknown> | unknown;
  deleteScipEdges?(input: { tenantId: string; projectId: string; evidenceUri: string; repository?: string }): Promise<void> | void;
  replaceScipEdges?(input: { tenantId: string; projectId: string; evidenceUri: string; repository?: string; edges: WorkerGraphEdgeInput[] }): Promise<void> | void;
}

export interface GitIngestOptions {
  embedFn?: (text: string) => Promise<number[]>;
  fetchFn?: typeof fetch;
  githubToken?: string;
  graphStore?: WorkerGraphStore;
  auditFn?: (event: DbAuditEvent, ctx: AuthContext) => Promise<void>;
  secretScanFn?: typeof scanForSecrets;
  piiRedactFn?: (text: string) => Promise<string>;
  onFileError?: (filePath: string, error: unknown) => void;
  onWarning?: (message: string) => void;
  gitState?: Pick<PgOperationalRepository, "getGitIngestionHead" | "advanceGitIngestionHead" | "withGitIngestionLock" | "getGitHubRefHead">;
  retireGitSources?: PgKnowledgeRepository["retireGitSources"];
  retireGitSourcesExcept?: PgKnowledgeRepository["retireGitSourcesExcept"];
  retireScipSymbolsExcept?: PgKnowledgeRepository["retireScipSymbolsExcept"];
  enqueueEmbed?: (payload: EmbedJobPayload) => Promise<void>;
  lockHeld?: boolean;
}

async function redactPiiWithAiWorker(text: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const aiWorkerUrl = process.env.AI_WORKER_URL;
  if (!aiWorkerUrl) return text;
  let response: Response;
  try {
    response = await fetchFn(`${aiWorkerUrl.replace(/\/$/, "")}/redact-pii`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text })
    });
  } catch {
    throw new Error("AI Worker indisponível; a ingestão foi bloqueada porque a sanitização PII configurada não pôde ser concluída.");
  }
  if (!response.ok) throw new Error(`AI Worker PII redaction failed: HTTP ${response.status}.`);
  let body: { redacted_text?: unknown };
  try { body = await response.json() as { redacted_text?: unknown }; }
  catch { throw new Error("AI Worker PII redaction returned invalid JSON."); }
  if (typeof body.redacted_text !== "string") throw new Error("AI Worker PII redaction response is missing redacted_text.");
  return body.redacted_text;
}

async function persistChunkEmbeddings(
  systemCtx: AuthContext,
  repo: WorkerKnowledgeRepo,
  item: { id: string; projectId: string; sourceVersion: string; accessPolicyId: string },
  chunks: readonly TextChunk[],
  embedFn: (text: string) => Promise<number[]>,
  warnings: string[],
  onWarning?: (message: string) => void
): Promise<number> {
  if (chunks.length === 0 || (!repo.replaceItemEmbeddings && !repo.upsertEmbedding)) {
    return 0;
  }

  const embeddingModel = process.env.EMBEDDING_MODEL ?? "bge-m3";
  const embeddedChunks: Array<{ chunkIndex: number; chunkText: string; embedding: number[] }> = [];

  try {
    for (const chunk of chunks) {
      const vector = await embedFn(chunk.text);
      embeddedChunks.push({
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        embedding: vector
      });
    }
  } catch (err) {
    const msg = `Embeddings ignorados para ${item.id} (Ollama indisponível): ${err instanceof Error ? err.message : String(err)}`;
    warnings.push(msg);
    onWarning?.(msg);
    return 0;
  }

  if (repo.replaceItemEmbeddings) {
    await repo.replaceItemEmbeddings(
      {
        tenantId: systemCtx.tenantId,
        allowedProjects: systemCtx.allowedProjects,
        allowedPolicies: systemCtx.allowedPolicies
      },
      {
        tenantId: systemCtx.tenantId,
        projectId: item.projectId,
        knowledgeItemId: item.id,
        sourceVersion: item.sourceVersion,
        accessPolicyId: item.accessPolicyId,
        embeddingModel,
        chunks: embeddedChunks
      }
    );
  } else if (repo.upsertEmbedding) {
    for (const chunk of embeddedChunks) {
      await repo.upsertEmbedding(systemCtx, {
        projectId: item.projectId,
        knowledgeItemId: item.id,
        sourceVersion: item.sourceVersion,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        accessPolicyId: item.accessPolicyId,
        embeddingModel,
        embedding: chunk.embedding
      });
    }
  }

  return embeddedChunks.length;
}

export async function processGitIngestJob(
  payload: GitIngestJobPayload,
  repo: WorkerKnowledgeRepo,
  optionsOrOnError?: GitIngestOptions | ((filePath: string, error: unknown) => void)
): Promise<{
  ingested: number;
  skippedSecrets: number;
  errors: number;
  chunksEmbedded: number;
  edgesCreated: number;
  scipSymbolsRetired: number;
  warnings: string[];
  sourceCommitSha?: string;
  ingestionMode?: "full" | "incremental";
  checkpointAdvanced?: boolean;
  ignoredOutOfOrder?: boolean;
}> {
  const options: GitIngestOptions =
    typeof optionsOrOnError === "function" ? { onFileError: optionsOrOnError } : (optionsOrOnError ?? {});
  if (options.gitState && !options.lockHeld && payload.owner && payload.repo) {
    const branch = payload.branch ?? payload.ref ?? "main";
    return options.gitState.withGitIngestionLock({ tenantId: payload.tenantId, actorId: "brain-worker", actorType: "system", roles: ["system"], allowedProjects: [payload.projectId], allowedPolicies: [payload.accessPolicyId ?? "internal-project", "restricted-security"] }, {
      projectId: payload.projectId, repository: `${payload.owner}/${payload.repo}`, branch
    }, () => processGitIngestJob(payload, repo, { ...options, lockHeld: true }));
  }
  const embedFn = options.embedFn ?? ((t: string) => fetchOllamaEmbedding(t));
  const accessPolicyId = payload.accessPolicyId ?? "internal-project";
  const systemCtx: AuthContext = {
    tenantId: payload.tenantId,
    actorId: "brain-worker",
    actorType: "system",
    roles: ["system"],
    allowedProjects: [payload.projectId],
    allowedPolicies: [...new Set([accessPolicyId, "restricted-security"])]
  };
  if (options.gitState && payload.owner && payload.repo && payload.commitSha) {
    const accepted = await options.gitState.getGitHubRefHead(systemCtx, {
      projectId: payload.projectId, repository: `${payload.owner}/${payload.repo}`,
      branch: payload.branch ?? payload.ref ?? "main"
    });
    if (accepted && accepted.commitSha !== payload.commitSha.toLowerCase()) {
      return { ingested: 0, skippedSecrets: 0, errors: 0, chunksEmbedded: 0, edgesCreated: 0, scipSymbolsRetired: 0, warnings: [], ignoredOutOfOrder: true };
    }
  }
  let ingested = 0;
  let skippedSecrets = 0;
  let errors = 0;
  let chunksEmbedded = 0;
  let edgesCreated = 0;
  let scipSymbolsRetired = 0;
  const warnings: string[] = [];
  const files: Array<{ path: string; content: string }> = [];
  let scipIndex: ScipIndex | undefined;
  let scipEvidenceUri: string | undefined;

  let sourceCommitSha = payload.commitSha;
  let remoteIsPrivate: boolean | undefined;
  let remoteRepository: string | undefined;
  let remoteDeletedPaths: string[] = [];
  let ingestionMode: "full" | "incremental" = "full";
  if (payload.owner || payload.repo) {
    if (!payload.owner || !payload.repo || !payload.ref) {
      throw new Error("Remote GitHub ingestion requires owner, repo, and ref.");
    }
    let githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
    const appId = process.env.GITHUB_APP_ID;
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!githubToken && (appId || installationId || privateKey)) {
      if (!appId || !installationId || !privateKey) {
        throw new Error("GitHub App auth requires GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY.");
      }
      const appJwt = createGitHubAppJwt(appId, privateKey);
      githubToken = (await exchangeInstallationToken(appJwt, installationId, options.fetchFn)).token;
    }
    const repositoryKey = `${payload.owner}/${payload.repo}`.toLowerCase();
    const branch = payload.branch ?? payload.ref;
    const fetchRemoteFiles = async () => {
      const checkpoint = options.gitState ? await options.gitState.getGitIngestionHead(systemCtx, { projectId: payload.projectId, repository: repositoryKey, branch }) : undefined;
      const canCompare = Boolean(checkpoint && payload.beforeCommitSha && checkpoint.commitSha === payload.beforeCommitSha.toLowerCase() && payload.commitSha && payload.commitSha !== checkpoint.commitSha);
      if (canCompare) {
        const incremental = await fetchRepoCommitChanges(payload.owner!, payload.repo!, checkpoint!.commitSha, payload.commitSha!, githubToken, {
          maxFiles: 500, maxFileBytes: 1_048_576, maxBinaryFileBytes: 16_777_216,
          pathFilter: (path) => path === "index.scip" || path === ".scip/index.scip" || (/\.(md|ya?ml|tsx?|jsx?|py|go)$/i.test(path) && !path.split("/").some((segment) => ["node_modules", "dist", "build", ".next", "vendor", ".git"].includes(segment)))
        }, options.fetchFn);
        if (!incremental.fallbackRequired) {
          ingestionMode = "incremental";
          remoteDeletedPaths = incremental.deletedPaths;
          return incremental;
        }
      }
      return fetchRepoTreeAndFiles(
        payload.owner!,
        payload.repo!,
        payload.ref!,
        githubToken,
        {
          maxFiles: 500,
          maxFileBytes: 1_048_576,
          maxBinaryFileBytes: 16_777_216,
          pathFilter: (path) => path === "index.scip" || path === ".scip/index.scip" || (
            /\.(md|ya?ml|tsx?|jsx?|py|go)$/i.test(path) &&
            !path.split("/").some((segment) => ["node_modules", "dist", "build", ".next", "vendor", ".git"].includes(segment)))
        },
        options.fetchFn
      );
    };
    const remote = await fetchRemoteFiles();
    if ("truncated" in remote && remote.truncated) throw new Error("GitHub retornou uma árvore truncada; a ingestão foi cancelada para evitar índice parcial.");
    sourceCommitSha = remote.commitSha;
    remoteIsPrivate = remote.isPrivate;
    remoteRepository = `${payload.owner}/${payload.repo}`;
    const remoteScip = remote.files.find(({ path }) => path === "index.scip" || path === ".scip/index.scip");
    if (remoteScip) {
      try {
        scipIndex = parseScipIndex(remoteScip.contentEncoding === "base64" ? Buffer.from(remoteScip.content, "base64") : remoteScip.content);
        scipEvidenceUri = remoteScip.path;
      } catch (error) {
        const warning = `Relações SCIP remotas ignoradas: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(warning);
        options.onWarning?.(warning);
      }
    }
    files.push(...remote.files.filter(({ path }) => path !== "index.scip" && path !== ".scip/index.scip").map(({ path, content }) => ({ path, content })));
  } else if (payload.repoDir) {
    const walk = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (["node_modules", ".git", "dist", ".next"].includes(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.(md|yaml|yml|ts|tsx|js|py|go)$/i.test(entry)) out.push(full);
      }
      return out;
    };
    for (const fullPath of walk(payload.repoDir)) {
      files.push({ path: relative(payload.repoDir, fullPath).replace(/\\/g, "/"), content: readFileSync(fullPath, "utf8") });
    }
    const projectRoot = realpathSync(payload.repoDir);
    for (const candidate of [join(projectRoot, "index.scip"), join(projectRoot, ".scip", "index.scip")]) {
      if (!existsSync(candidate)) continue;
      try {
        if (!lstatSync(candidate).isFile()) throw new Error("Índice SCIP precisa ser um arquivo regular, não symlink.");
        const resolvedIndex = realpathSync(candidate);
        const relativeIndex = relative(projectRoot, resolvedIndex).replace(/\\/g, "/");
        if (relativeIndex === ".." || relativeIndex.startsWith("../")) throw new Error("Índice SCIP fora da raiz do projeto.");
        scipIndex = parseScipIndex(readFileSync(resolvedIndex));
        scipEvidenceUri = relativeIndex;
        break;
      } catch (error) {
        const warning = `Relações SCIP ignoradas: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(warning);
        options.onWarning?.(warning);
      }
    }
  } else {
    throw new Error("Git ingestion requires a local repoDir or remote GitHub owner/repo/ref.");
  }

  if (remoteRepository && options.retireGitSources && remoteDeletedPaths.length > 0) {
    const uris = remoteDeletedPaths.map((path) => remoteIsPrivate === false ? `external/${remoteRepository}/${path}` : path);
    const retired = await options.retireGitSources(systemCtx, { projectId: payload.projectId, repository: remoteRepository, sourceUris: uris });
    if (retired > 0 && options.auditFn) {
      await options.auditFn({ tenantId: payload.tenantId, projectId: payload.projectId, accessPolicyId, actorId: systemCtx.actorId, actorType: systemCtx.actorType, action: "delete", targetType: "github_source", metadata: { sourceRepository: remoteRepository, sourceUris: uris, retired } }, systemCtx);
    }
  }

  const persistedItemsByPath = new Map<string, { id: string; accessPolicyId: string; item: KnowledgeItem }>();
  for (const { path: rel, content } of files) {
    try {
      const secretScan: SecretScanResult = (options.secretScanFn ?? scanForSecrets)(content);
      if (secretScan.engine === "unavailable") {
        throw new Error("Gitleaks is unavailable; file ingestion was blocked.");
      }
      if (!secretScan.clean) {
        skippedSecrets += 1;
        if (remoteRepository && options.retireGitSources) {
          const secretSourceUri = remoteIsPrivate === false ? `external/${remoteRepository}/${rel}` : rel;
          const retired = await options.retireGitSources(systemCtx, { projectId: payload.projectId, repository: remoteRepository, sourceUris: [secretSourceUri] });
          if (retired > 0 && options.auditFn) await options.auditFn({ tenantId: payload.tenantId, projectId: payload.projectId, accessPolicyId, actorId: systemCtx.actorId, actorType: systemCtx.actorType, action: "delete", targetType: "github_source", metadata: { sourceRepository: remoteRepository, sourceUri: secretSourceUri, reason: "secret_scan" } }, systemCtx);
        }
        continue;
      }
      const remotePath = remoteRepository && remoteIsPrivate === false
        ? `external/${remoteRepository}/${rel}`
        : rel;
      const sanitizedContent = await (options.piiRedactFn ?? ((text: string) => redactPiiWithAiWorker(text, options.fetchFn)))(content);
      const piiRedacted = sanitizedContent !== content;
      const item = parseKnowledgeFile({
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        filePath: remotePath,
        rawContent: sanitizedContent,
        commitSha: sourceCommitSha
      });
      if (remoteRepository) {
        item.metadata = { ...(item.metadata ?? {}), sourceRepository: remoteRepository.toLowerCase() };
      }
      if (remoteRepository && remoteIsPrivate === false) {
        item.id = `external:${remoteRepository}:${item.id}`;
        item.sourceOrigin = "external_reference";
        item.status = "draft";
        item.trustLevel = "untrusted";
        item.confidence = Math.min(item.confidence, 0.5);
      }
      if (!systemCtx.allowedPolicies.includes(item.accessPolicyId)) {
        throw new Error(`Git item '${item.id}' requests policy '${item.accessPolicyId}' outside the job scope.`);
      }
      const chunks = /\.(ts|tsx|js|py|go)$/i.test(rel) ? chunkCodeByAst(rel, sanitizedContent) : chunkMarkdown(sanitizedContent);
      const anchors = extractCodeAnchors(rel, sanitizedContent);

      const upsert = await repo.upsertItem(systemCtx, item);
      const persistedItem = { ...item, sourceVersion: upsert.sourceVersion ?? item.sourceVersion };
      persistedItemsByPath.set(rel, { id: item.id, accessPolicyId: item.accessPolicyId, item: persistedItem });
      if (upsert.changed) ingested += 1;
      if (options.auditFn) {
        await options.auditFn({
          tenantId: item.tenantId,
          projectId: item.projectId,
          accessPolicyId: item.accessPolicyId,
          actorId: systemCtx.actorId,
          actorType: systemCtx.actorType,
          action: upsert.version === 1 ? "create" : "update",
          targetType: "knowledge_item",
          targetId: item.id,
          metadata: {
            source: "git_ingest",
            sourceUri: item.sourceUri,
            sourceRepository: remoteRepository?.toLowerCase(),
            sourceVersion: persistedItem.sourceVersion,
            version: upsert.version,
            changed: upsert.changed,
            contentHash: item.contentHash,
            piiRedacted
          }
        }, systemCtx);
      }

      if (options.enqueueEmbed) {
        await options.enqueueEmbed({
          tenantId: persistedItem.tenantId,
          projectId: persistedItem.projectId,
          itemId: persistedItem.id,
          sourceVersion: persistedItem.sourceVersion,
          content: sanitizedContent,
          accessPolicyId: persistedItem.accessPolicyId
        });
      } else {
        chunksEmbedded += await persistChunkEmbeddings(
          systemCtx,
          repo,
          persistedItem,
          chunks,
          embedFn,
          warnings,
          options.onWarning
        );
      }

      if (options.graphStore && anchors.length > 0 && !(remoteRepository && remoteIsPrivate === false)) {
        for (const anchor of anchors) {
          await options.graphStore.addEdge({
            tenantId: payload.tenantId,
            fromProjectId: payload.projectId,
            toProjectId: payload.projectId,
            fromItemId: item.id,
            toItemId: anchor.targetId,
            fromPolicyId: item.accessPolicyId,
            toPolicyId: item.accessPolicyId,
            relationType: anchor.relationType,
            isInferred: anchor.isInferred,
            confidence: anchor.confidence
          });
          edgesCreated += 1;
        }
      }
    } catch (err) {
      errors += 1;
      options.onFileError?.(rel, err);
      if (err instanceof WorkerAuditWriteError) throw err;
    }
  }
  if (scipIndex && scipEvidenceUri) {
    const symbolItemsByName = new Map<string, { id: string; accessPolicyId: string; record: ReturnType<typeof extractScipSymbols>[number] }>();
    let scipReconciliationSafe = true;
    for (const record of extractScipSymbols(scipIndex)) {
      const source = persistedItemsByPath.get(record.relativePath);
      if (!source) {
        scipReconciliationSafe = false;
        continue;
      }
      try {
        const rawContent = [`SCIP symbol: ${record.symbol}`, ...record.documentation].join("\n\n");
        const secretScan = (options.secretScanFn ?? scanForSecrets)(rawContent);
        if (secretScan.engine === "unavailable" || !secretScan.clean) {
          if (secretScan.engine === "unavailable") scipReconciliationSafe = false;
          if (!secretScan.clean) skippedSecrets += 1;
          warnings.push(`Símbolo SCIP '${record.symbol}' ignorado: documentação não passou pela verificação de segredos.`);
          continue;
        }
        const content = await (options.piiRedactFn ?? ((text: string) => redactPiiWithAiWorker(text, options.fetchFn)))(rawContent);
        const line = record.definitionRange[0] + 1;
        const itemId = `SCIP-${createHash("sha256").update(record.symbol).digest("hex").slice(0, 24)}`;
        const symbolItem: KnowledgeItem = {
          id: itemId,
          tenantId: source.item.tenantId,
          projectId: source.item.projectId,
          domainId: source.item.domainId,
          type: "code_symbol",
          title: record.displayName || record.symbol,
          content,
          summary: `${record.language} ${record.displayName || record.symbol} em ${record.relativePath}:${line}`,
          status: source.item.status,
          sourceId: source.item.sourceId,
          sourceOrigin: source.item.sourceOrigin,
          sourceKind: "git",
          sourceVersion: source.item.sourceVersion,
          sourceUri: source.item.sourceUri,
          version: 1,
          contentHash: createHash("sha256").update(content).digest("hex"),
          confidence: source.item.confidence,
          trustLevel: source.item.trustLevel,
          isInferred: false,
          tags: ["scip", record.language],
          relatedIds: [source.item.id],
          accessPolicyId: source.accessPolicyId,
          metadata: {
            source: "scip", symbol: record.symbol, language: record.language,
            filePath: record.relativePath, definitionRange: record.definitionRange,
            kind: record.kind, enclosingSymbol: record.enclosingSymbol,
            sourceRepository: source.item.metadata?.sourceRepository
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        const upsert = await repo.upsertItem(systemCtx, symbolItem);
        const persistedSymbol = { ...symbolItem, sourceVersion: upsert.sourceVersion ?? symbolItem.sourceVersion };
        symbolItemsByName.set(record.symbol, { id: itemId, accessPolicyId: source.accessPolicyId, record });
        if (upsert.changed) ingested += 1;
        if (options.auditFn) await options.auditFn({
          tenantId: symbolItem.tenantId, projectId: symbolItem.projectId, accessPolicyId: symbolItem.accessPolicyId,
          actorId: systemCtx.actorId, actorType: systemCtx.actorType,
          action: upsert.version === 1 ? "create" : "update", targetType: "knowledge_item", targetId: itemId,
          metadata: { source: "scip_symbol", sourceUri: symbolItem.sourceUri, sourceVersion: persistedSymbol.sourceVersion, contentHash: symbolItem.contentHash }
        }, systemCtx);
        if (options.enqueueEmbed) await options.enqueueEmbed({
          tenantId: persistedSymbol.tenantId, projectId: persistedSymbol.projectId, itemId,
          sourceVersion: persistedSymbol.sourceVersion, content, accessPolicyId: persistedSymbol.accessPolicyId
        });
        else chunksEmbedded += await persistChunkEmbeddings(systemCtx, repo, persistedSymbol, chunkCodeByAst(record.relativePath, content), embedFn, warnings, options.onWarning);
      } catch (error) {
        errors += 1;
        scipReconciliationSafe = false;
        options.onFileError?.(`${record.relativePath}#${record.symbol}`, error);
        if (error instanceof WorkerAuditWriteError) throw error;
      }
    }
    if (scipReconciliationSafe && options.retireScipSymbolsExcept) {
      scipSymbolsRetired = await options.retireScipSymbolsExcept(systemCtx, {
        projectId: payload.projectId,
        ...(remoteRepository ? { repository: remoteRepository } : {}),
        retainedItemIds: [...symbolItemsByName.values()].map(({ id }) => id)
      });
    }
    const scipEdges: WorkerGraphEdgeInput[] = [];
    if (scipReconciliationSafe && options.graphStore) for (const { id, accessPolicyId, record } of symbolItemsByName.values()) {
      const source = persistedItemsByPath.get(record.relativePath)!;
      scipEdges.push({ tenantId: payload.tenantId, fromProjectId: payload.projectId, toProjectId: payload.projectId,
        fromItemId: source.id, toItemId: id, fromPolicyId: source.accessPolicyId, toPolicyId: accessPolicyId,
        relationType: "IMPLEMENTS", isInferred: false, confidence: 1, evidenceUri: scipEvidenceUri,
        metadata: { source: "scip", symbol: record.symbol, definitionRange: record.definitionRange, ...(remoteRepository ? { sourceRepository: remoteRepository.toLowerCase() } : {}) } });
    }
    if (scipReconciliationSafe && options.graphStore) for (const { id, accessPolicyId, record } of symbolItemsByName.values()) {
      for (const relationship of record.relationships) {
        const target = symbolItemsByName.get(relationship.symbol);
        if (!target || !systemCtx.allowedPolicies.includes(accessPolicyId) || !systemCtx.allowedPolicies.includes(target.accessPolicyId)) continue;
        scipEdges.push({
          tenantId: payload.tenantId, fromProjectId: payload.projectId, toProjectId: payload.projectId,
          fromItemId: id, toItemId: target.id, fromPolicyId: accessPolicyId, toPolicyId: target.accessPolicyId,
          relationType: relationship.isImplementation ? "IMPLEMENTS" : "DEPENDS_ON",
          isInferred: false, confidence: 1, evidenceUri: scipEvidenceUri,
          metadata: { source: "scip", fromSymbol: record.symbol, toSymbol: relationship.symbol, flags: relationship, ...(remoteRepository ? { sourceRepository: remoteRepository.toLowerCase() } : {}) }
        });
      }
    }
    if (scipReconciliationSafe && options.graphStore) for (const relation of extractScipDocumentRelationships(scipIndex)) {
      const from = persistedItemsByPath.get(relation.fromPath);
      const to = persistedItemsByPath.get(relation.toPath);
      if (!from || !to) continue;
      if (!systemCtx.allowedPolicies.includes(from.accessPolicyId) || !systemCtx.allowedPolicies.includes(to.accessPolicyId)) continue;
      scipEdges.push({
        tenantId: payload.tenantId,
        fromProjectId: payload.projectId,
        toProjectId: payload.projectId,
        fromItemId: from.id,
        toItemId: to.id,
        fromPolicyId: from.accessPolicyId,
        toPolicyId: to.accessPolicyId,
        relationType: relation.relationType,
        isInferred: false,
        confidence: 1.0,
        evidenceUri: scipEvidenceUri,
        metadata: { source: "scip", symbolMappings: relation.mappings, ...(remoteRepository ? { sourceRepository: remoteRepository.toLowerCase() } : {}) }
      });
    }
    if (scipReconciliationSafe && options.graphStore) {
      const scope = { tenantId: payload.tenantId, projectId: payload.projectId, evidenceUri: scipEvidenceUri, ...(remoteRepository ? { repository: remoteRepository } : {}) };
      if (options.graphStore.replaceScipEdges) {
        await options.graphStore.replaceScipEdges({ ...scope, edges: scipEdges });
        edgesCreated += scipEdges.length;
      } else {
        if (options.graphStore.deleteScipEdges) await options.graphStore.deleteScipEdges(scope);
        for (const edge of scipEdges) { await options.graphStore.addEdge(edge); edgesCreated += 1; }
      }
    }
  }
  let checkpointAdvanced = false;
  if (remoteRepository && ingestionMode === "full" && errors === 0 && options.retireGitSourcesExcept) {
    const retainedSourceUris = files.map(({ path }) => remoteIsPrivate === false ? `external/${remoteRepository}/${path}` : path);
    const retired = await options.retireGitSourcesExcept(systemCtx, { projectId: payload.projectId, repository: remoteRepository, retainedSourceUris });
    if (retired > 0 && options.auditFn) await options.auditFn({ tenantId: payload.tenantId, projectId: payload.projectId, accessPolicyId, actorId: systemCtx.actorId, actorType: systemCtx.actorType, action: "delete", targetType: "github_source", metadata: { sourceRepository: remoteRepository, retainedSourceUrisCount: retainedSourceUris.length, retired, reason: "full_snapshot_reconciliation" } }, systemCtx);
  }
  if (remoteRepository && options.gitState && sourceCommitSha && errors === 0) {
    const branch = payload.branch ?? payload.ref ?? "main";
    const previous = await options.gitState.getGitIngestionHead(systemCtx, { projectId: payload.projectId, repository: remoteRepository, branch });
    checkpointAdvanced = await options.gitState.advanceGitIngestionHead(systemCtx, {
      projectId: payload.projectId, repository: remoteRepository, branch, commitSha: sourceCommitSha, accessPolicyId,
      ...(previous ? { expectedPreviousCommitSha: previous.commitSha } : {})
    });
  }
  return { ingested, skippedSecrets, errors, chunksEmbedded, edgesCreated, scipSymbolsRetired, warnings, ingestionMode, checkpointAdvanced, ...(sourceCommitSha ? { sourceCommitSha } : {}) };
}

