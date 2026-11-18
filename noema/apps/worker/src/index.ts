import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import PgBoss from "pg-boss";
import { Ollama } from "ollama";
import {
  executeRunnerAgentLoop,
  executeRunnerTaskWithAppleFm,
  executeRunnerTaskWithOllama,
  startRunnerDaemon
} from "@noema/agent-runner";
import type { AuthContext } from "@noema/auth";
import { extractCodeAnchors, extractScipDocumentRelationships, extractScipSymbols, parseScipIndex, type ScipIndex } from "@noema/code-intelligence";
import { deduplicateCanonicalItems, runWithExponentialBackoff } from "@noema/connector-framework";
import { createGitHubAppJwt, exchangeInstallationToken, fetchRepoCommitChanges, fetchRepoTreeAndFiles } from "@noema/ingestion";
import type { KnowledgeItem } from "@noema/core";
import {
  createAppPostgresClient,
  createDatabaseClient,
  PgKnowledgeRepository,
  PgOperationalRepository
} from "@noema/database";
import type { DbAuditEvent } from "@noema/database";
import { createPostgresGraphStore, type RelationType } from "@noema/graph";
import { chunkCodeByAst, chunkMarkdown, scanForSecrets, type SecretScanResult, type TextChunk } from "@noema/ingestion";
import { parseKnowledgeFile, type KnowledgeRepository } from "@noema/knowledge";
import { initTelemetry, startSpan } from "@noema/observability";

export interface EmbedJobPayload {
  tenantId: string;
  projectId: string;
  itemId: string;
  sourceVersion: string;
  accessPolicyId: string;
  content: string;
}

export interface ApprovalReminderJobPayload {
  tenantId: string; projectId: string; proposalId: string; accessPolicyId: string; dueAt: string;
  eventType: "reminder" | "escalation";
}

export interface RunnerScheduleJobPayload {
  scheduleId: string;
  tenantId: string;
  projectId: string;
  actorId: string;
  accessPolicyId: string;
  instruction: string;
  priority: "low" | "normal" | "high";
  maxSteps?: number;
  timeoutSeconds?: number;
}

export async function materializeScheduledRunnerTask(
  payload: RunnerScheduleJobPayload,
  jobId: string,
  opRepo: Pick<PgOperationalRepository, "saveScheduledRunnerTask">
): Promise<{ taskId: string }> {
  if (!payload.tenantId || !payload.projectId || !payload.accessPolicyId || !payload.instruction?.trim()) {
    throw new Error("Scheduled Runner task is missing its tenant, project, policy, or instruction scope.");
  }
  const ctx: AuthContext = {
    tenantId: payload.tenantId,
    actorId: payload.actorId,
    actorType: "system",
    roles: ["system"],
    allowedProjects: [payload.projectId],
    allowedPolicies: [payload.accessPolicyId]
  };
  const taskId = `RUN-${jobId}`;
  await opRepo.saveScheduledRunnerTask(ctx, {
    taskId,
    projectId: payload.projectId,
    instruction: payload.instruction,
    priority: payload.priority
  });
  return { taskId };
}

export async function refreshRunnerScheduleWorkers(
  boss: Pick<PgBoss, "getSchedules" | "work" | "offWork">,
  opRepo: Pick<PgOperationalRepository, "saveScheduledRunnerTask">,
  registered = new Set<string>()
): Promise<Set<string>> {
  const schedules = (await boss.getSchedules()).filter((schedule) => schedule.name.startsWith("noema.runner-schedule-"));
  const activeNames = new Set(schedules.map((schedule) => schedule.name));
  for (const name of registered) {
    if (activeNames.has(name)) continue;
    await boss.offWork(name);
    registered.delete(name);
  }
  for (const schedule of schedules) {
    if (registered.has(schedule.name)) continue;
    await boss.work<RunnerScheduleJobPayload>(schedule.name, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await materializeScheduledRunnerTask(job.data, job.id, opRepo);
    });
    registered.add(schedule.name);
  }
  return registered;
}

export async function fetchOllamaEmbedding(
  text: string,
  model = process.env.EMBEDDING_MODEL ?? "bge-m3",
  baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchFn: typeof fetch = fetch
): Promise<number[]> {
  const ollama = new Ollama({ host: baseUrl.replace(/\/$/, ""), fetch: fetchFn });
  const result = await ollama.embed({ model, input: text });
  const embedding = result.embeddings[0];
  if (!Array.isArray(embedding)) {
    throw new Error("Resposta inválida do Ollama (campo embedding ausente).");
  }
  return embedding;
}

export type OllamaEmbeddingProviderStatus =
  | { available: true }
  | { available: false; reason: "model_missing" | "provider_unreachable" };

export async function probeOllamaEmbeddingProvider(
  model = process.env.EMBEDDING_MODEL ?? "bge-m3",
  baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  fetchFn: typeof fetch = fetch
): Promise<OllamaEmbeddingProviderStatus> {
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(1_500)
    });
    if (!response.ok) return { available: false, reason: "provider_unreachable" };
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const configuredNames = new Set([model, `${model}:latest`]);
    const modelLoaded = body.models?.some((entry) =>
      (entry.name && configuredNames.has(entry.name)) || (entry.model && configuredNames.has(entry.model))
    ) ?? false;
    return modelLoaded ? { available: true } : { available: false, reason: "model_missing" };
  } catch {
    return { available: false, reason: "provider_unreachable" };
  }
}

export async function processEmbedJob(
  payload: EmbedJobPayload,
  repo: Pick<PgKnowledgeRepository, "upsertEmbedding" | "getEmbeddingSource">,
  embedFn: (text: string) => Promise<number[]> = (t) => fetchOllamaEmbedding(t),
  auditFn?: (event: DbAuditEvent, ctx: AuthContext) => Promise<void>
): Promise<{ chunksIndexed: number }> {
  const systemCtx: AuthContext = {
    tenantId: payload.tenantId,
    actorId: "noema-worker",
    actorType: "system",
    roles: ["system"],
    allowedProjects: [payload.projectId],
    allowedPolicies: [payload.accessPolicyId]
  };

  const source = await repo.getEmbeddingSource(systemCtx, {
    projectId: payload.projectId,
    itemId: payload.itemId,
    sourceVersion: payload.sourceVersion
  });
  if (!source) {
    throw new Error(`Embedding source '${payload.itemId}' version '${payload.sourceVersion}' is missing or outside the job scope.`);
  }
  if (source.accessPolicyId !== payload.accessPolicyId) {
    throw new Error(`Embedding source '${payload.itemId}' policy '${source.accessPolicyId}' is outside the job scope.`);
  }
  const chunks = chunkMarkdown(source.content);

  for (const chunk of chunks) {
    const vector = await embedFn(chunk.text);
    await repo.upsertEmbedding(systemCtx, {
      projectId: payload.projectId,
      knowledgeItemId: payload.itemId,
      sourceVersion: payload.sourceVersion,
      chunkIndex: chunk.index,
      chunkText: chunk.text,
      accessPolicyId: payload.accessPolicyId,
      embeddingModel: process.env.EMBEDDING_MODEL ?? "bge-m3",
      embedding: vector
    });
  }
  if (auditFn) {
    await auditFn({
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      accessPolicyId: source.accessPolicyId,
      actorId: systemCtx.actorId,
      actorType: systemCtx.actorType,
      action: "upsert",
      targetType: "knowledge_embedding",
      targetId: payload.itemId,
      metadata: {
        source: "embed_item",
        sourceVersion: payload.sourceVersion,
        chunksIndexed: chunks.length,
        embeddingModel: process.env.EMBEDDING_MODEL ?? "bge-m3"
      }
    }, systemCtx);
  }
  return { chunksIndexed: chunks.length };
}

export async function enqueueEmbedJob(
  payload: EmbedJobPayload,
  databaseUrl = process.env.DATABASE_URL
): Promise<string | null> {
  if (!databaseUrl) return null;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("noema.embed-item");
  const jobId = await boss.send("noema.embed-item", payload);
  await boss.stop();
  return jobId;
}

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

class WorkerAuditWriteError extends Error {
  constructor(itemId: string, cause: unknown) {
    super(`Required audit write failed for knowledge item '${itemId}'.`, { cause });
    this.name = "WorkerAuditWriteError";
  }
}

async function persistWorkerAudit(
  client: ReturnType<typeof createAppPostgresClient>,
  event: DbAuditEvent,
  ctx: AuthContext
): Promise<void> {
  try {
    await client.withRlsTransaction({
      tenantId: ctx.tenantId,
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies
    }, async (transaction) => {
      const jsonMetadata = (transaction as unknown as { json(value: unknown): unknown }).json(event.metadata ?? {});
      await transaction`INSERT INTO audit_logs (
        tenant_id, project_id, access_policy_id, actor_id, actor_type,
        action, target_type, target_id, metadata
      ) VALUES (
        ${event.tenantId}, ${event.projectId}, ${event.accessPolicyId}, ${event.actorId}, ${event.actorType},
        ${event.action}, ${event.targetType}, ${event.targetId ?? null}, ${jsonMetadata}
      )`;
    });
  } catch (error) {
    throw new WorkerAuditWriteError(event.targetId ?? "unknown", error);
  }
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
    return options.gitState.withGitIngestionLock({ tenantId: payload.tenantId, actorId: "noema-worker", actorType: "system", roles: ["system"], allowedProjects: [payload.projectId], allowedPolicies: [payload.accessPolicyId ?? "internal-project", "restricted-security"] }, {
      projectId: payload.projectId, repository: `${payload.owner}/${payload.repo}`, branch
    }, () => processGitIngestJob(payload, repo, { ...options, lockHeld: true }));
  }
  const embedFn = options.embedFn ?? ((t: string) => fetchOllamaEmbedding(t));
  const accessPolicyId = payload.accessPolicyId ?? "internal-project";
  const systemCtx: AuthContext = {
    tenantId: payload.tenantId,
    actorId: "noema-worker",
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

export interface WorkerShutdownRuntime {
  stopAccepting: () => void | Promise<void>;
  stopQueue: () => void | Promise<void>;
  closeConnections: () => void | Promise<void>;
}

export function createWorkerShutdown(runtime: WorkerShutdownRuntime): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [runtime.stopAccepting, runtime.stopQueue, runtime.closeConnections]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        const reasons = errors.map((error) => error instanceof Error ? error.message : String(error));
        throw new AggregateError(errors, `Worker shutdown after ${signal} had cleanup failures: ${reasons.join("; ")}`);
      }
    })();
    return shutdownPromise;
  };
}

export async function startWorker(
  databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL,
  appDatabaseUrl = process.env.DATABASE_URL ?? databaseUrl
) {
  if (!databaseUrl) throw new Error("DATABASE_SYSTEM_URL ou DATABASE_URL obrigatória para iniciar @noema/worker.");
  initTelemetry("noema-worker");
  const pgBossSchema = process.env.NOEMA_PG_BOSS_SCHEMA ?? "pgboss";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pgBossSchema)) {
    throw new Error("NOEMA_PG_BOSS_SCHEMA must be a valid SQL identifier.");
  }
  const quotedPgBossSchema = `"${pgBossSchema}"`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: pgBossSchema });
  const { client: systemSql, db } = createDatabaseClient(databaseUrl);
  const appClient = createAppPostgresClient({ databaseUrl: appDatabaseUrl });
  const repo = new PgKnowledgeRepository(db);
  const opRepo = new PgOperationalRepository(db);

  await boss.start();
  // Permite que a API (role brain_app) enfileire jobs em pgboss sem precisar de BYPASSRLS.
  const { client: workerSql } = createDatabaseClient(databaseUrl);
  try {
    await workerSql.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
          BEGIN
            GRANT USAGE ON SCHEMA ${quotedPgBossSchema} TO brain_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedPgBossSchema} TO brain_app;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quotedPgBossSchema} TO brain_app;
          EXCEPTION WHEN insufficient_privilege THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
  } finally {
    await workerSql.end();
  }
  const runnerScheduleConsumers = new Set<string>();
  const refreshRunnerConsumers = () => refreshRunnerScheduleWorkers(boss, opRepo, runnerScheduleConsumers);
  await refreshRunnerConsumers();
  const runnerScheduleRefresh = setInterval(() => {
    void refreshRunnerConsumers().catch((error) => {
      console.error(JSON.stringify({
        event: "runner_schedule_discovery_failed",
        error: error instanceof Error ? error.message : String(error)
      }));
    });
  }, 30_000);
  runnerScheduleRefresh.unref();
  await boss.createQueue("noema.embed-item");
  await boss.work<EmbedJobPayload>("noema.embed-item", async (jobs) => {
    for (const job of jobs) {
      const span = startSpan("worker.embed_item");
      try {
        const result = await processEmbedJob(job.data, repo, undefined, (event, ctx) => persistWorkerAudit(appClient, event, ctx));
        return result;
      } finally {
        span.end({ projectId: job.data.projectId, itemId: job.data.itemId });
      }
    }
  });

  await boss.createQueue("noema.ingest-git");
  await boss.work<GitIngestJobPayload>("noema.ingest-git", { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const graphStore = createPostgresGraphStore(appClient, {
        tenantId: job.data.tenantId,
        allowedProjects: [job.data.projectId],
        allowedPolicies: [...new Set([job.data.accessPolicyId ?? "internal-project", "restricted-security"])]
      });
      const result = await processGitIngestJob(job.data, repo, {
        graphStore,
        gitState: opRepo,
        retireGitSources: repo.retireGitSources.bind(repo),
        retireGitSourcesExcept: repo.retireGitSourcesExcept.bind(repo),
        retireScipSymbolsExcept: repo.retireScipSymbolsExcept.bind(repo),
        enqueueEmbed: async (embedPayload) => { await boss.send("noema.embed-item", embedPayload); },
        auditFn: (event, ctx) => persistWorkerAudit(appClient, event, ctx),
        onFileError: (filePath, error) => {
          console.error(JSON.stringify({
            event: "git_ingest_file_failed",
            projectId: job.data.projectId,
            filePath,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      });
      console.log(JSON.stringify({
        event: "git_ingest_completed",
        jobId: job.id,
        projectId: job.data.projectId,
        source: job.data.owner && job.data.repo ? `${job.data.owner}/${job.data.repo}` : "local",
        commitSha: result.sourceCommitSha,
        ...result
      }));
      return result;
    }
  });

  await boss.createQueue("noema.memory-decay");
  await boss.schedule("noema.memory-decay", "0 * * * *", {
    tenantId: process.env.NOEMA_TENANT_ID ?? "default-org",
    projectId: process.env.NOEMA_PROJECT_ID ?? "default",
    accessPolicyId: "internal-project"
  });
  await boss.work<{ tenantId: string; projectId: string; accessPolicyId: string }>(
    "noema.memory-decay",
    async (jobs) => {
      for (const job of jobs) {
        const ctx: AuthContext = {
          tenantId: job.data.tenantId,
          actorId: "noema-worker",
          actorType: "system",
          roles: ["system"],
          allowedProjects: [job.data.projectId],
          allowedPolicies: [job.data.accessPolicyId]
        };
        const result = await opRepo.runMemoryDecay(ctx);
        await persistWorkerAudit(appClient, {
          tenantId: job.data.tenantId,
          projectId: job.data.projectId,
          accessPolicyId: job.data.accessPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "decay",
          targetType: "memory_decay",
          targetId: job.id,
          metadata: { source: "memory_decay", ...result }
        }, ctx);
        return result;
      }
    }
  );

  await boss.createQueue("noema.approval-reminder");
  await boss.work<ApprovalReminderJobPayload>("noema.approval-reminder", async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      const ctx: AuthContext = { tenantId: payload.tenantId, actorId: "noema-worker", actorType: "system", roles: ["system"], allowedProjects: [payload.projectId], allowedPolicies: [payload.accessPolicyId] };
      const recorded = await opRepo.recordApprovalReminder(ctx, {
        projectId: payload.projectId,
        proposalId: payload.proposalId,
        accessPolicyId: payload.accessPolicyId,
        dueAt: new Date(payload.dueAt),
        eventType: payload.eventType
      });
      await persistWorkerAudit(appClient, {
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        accessPolicyId: payload.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: payload.eventType,
        targetType: "approval_reminder",
        targetId: payload.proposalId,
        metadata: { source: "approval_reminder", dueAt: payload.dueAt, inserted: recorded }
      }, ctx);
      return { recorded };
    }
  });

  const apiBaseUrl = (process.env.NOEMA_API_URL ?? `http://localhost:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
  const apiKey = process.env.NOEMA_LOCAL_API_KEY;
  if (apiKey) {
    const dailyTokenLimit = Number(process.env.NOEMA_RUNNER_DAILY_TOKEN_LIMIT ?? 100_000);
    startRunnerDaemon({
      pollIntervalMs: Number(process.env.NOEMA_RUNNER_POLL_MS ?? 2000),
      taskSource: {
        async claimNextRunnerTask() {
          const claimed = await opRepo.claimNextRunnerTask();
          return claimed ?? undefined;
        },
        async completeRunnerTask(taskId, status, resultSummary, resultMetadata) {
          await opRepo.completeRunnerTask(taskId, status, resultSummary, resultMetadata);
        }
      },
      executeTask: (task) =>
        executeRunnerAgentLoop(task, {
          recordBudgetUsage: (tenantId, projectId, tokens) => opRepo.recordRunnerTokenUsage(tenantId, projectId, tokens, dailyTokenLimit),
          ...(process.env.NOEMA_RUNNER_MODEL_EXECUTION === "ollama" || process.env.NOEMA_RUNNER_MODEL_EXECUTION === "apple-fm" || process.env.NOEMA_RUNNER_MODEL_EXECUTION === "fm" ? {
            callModel: async ({ task: runnerTask, context }) => {
              const enrichedTask = {
                ...runnerTask,
                instruction: `${runnerTask.instruction}\n\nAuthorized Context Pack (JSON):\n${JSON.stringify(context)}`
              };
              const generated = process.env.NOEMA_RUNNER_MODEL_EXECUTION === "ollama"
                ? await executeRunnerTaskWithOllama(enrichedTask)
                : await executeRunnerTaskWithAppleFm(enrichedTask);
              return {
                response: (generated.resultSummary ?? "").replace(/^\[bot-draft\]\s*/, ""),
                usage: generated.modelUsage
              };
            }
          } : {}),
          callTool: async (toolName, args) => {
            const headers = {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`
            };
            if (toolName === "brain_context_build") {
              const res = await fetch(`${apiBaseUrl}/v1/projects/${encodeURIComponent(String(args.projectId))}/context`, {
                method: "POST",
                headers,
                body: JSON.stringify({ task: args.task, tokenBudget: args.tokenBudget ?? 3000 })
              });
              if (!res.ok) throw new Error(`Context API HTTP ${res.status}`);
              return res.json();
            }
            if (toolName === "brain_change_propose") {
              const res = await fetch(`${apiBaseUrl}/v1/projects/${encodeURIComponent(String(args.projectId))}/change/propose`, {
                method: "POST",
                headers,
                body: JSON.stringify({ title: args.title, content: args.content })
              });
              if (!res.ok) throw new Error(`Proposals API HTTP ${res.status}`);
              return res.json();
            }
            throw new Error(`Tool '${toolName}' não suportada pelo Brain Runner loop.`);
          }
        })
    });
  }

  const shutdown = createWorkerShutdown({
    stopAccepting: () => clearInterval(runnerScheduleRefresh),
    stopQueue: () => boss.stop({ graceful: true, timeout: 30_000, wait: true }),
    closeConnections: async () => {
      const closeResults = await Promise.allSettled([
        systemSql.end({ timeout: 5 }),
        appClient.close({ timeoutSeconds: 5 })
      ]);
      const closeErrors = closeResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Worker PostgreSQL client shutdown failed.");
    }
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    process.off("SIGTERM", handleSigterm);
    process.off("SIGINT", handleSigint);
    console.log(JSON.stringify({ event: "worker_shutdown_started", signal }));
    void shutdown(signal).then(() => {
      process.stdout.write(`${JSON.stringify({ event: "worker_shutdown_completed", signal })}\n`, () => process.exit(0));
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ event: "worker_shutdown_failed", signal, error: message })}\n`, () => process.exit(1));
    });
  };
  const handleSigterm = () => handleSignal("SIGTERM");
  const handleSigint = () => handleSignal("SIGINT");
  process.once("SIGTERM", handleSigterm);
  process.once("SIGINT", handleSigint);

  return boss;
}

if (process.argv[1]?.endsWith("index.js")) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
