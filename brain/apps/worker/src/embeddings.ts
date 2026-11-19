import PgBoss from "pg-boss";
import { Ollama } from "ollama";
import type { AuthContext } from "@brain/auth";
import { createAppPostgresClient, PgKnowledgeRepository, PgOperationalRepository } from "@brain/database";
import type { DbAuditEvent } from "@brain/database";
import { chunkMarkdown } from "@brain/ingestion";

export interface EmbedJobPayload {
  tenantId: string;
  projectId: string;
  itemId: string;
  sourceVersion: string;
  accessPolicyId: string;
  content: string;
}

export interface ApprovalReminderJobPayload {
  tenantId: string;
  projectId: string;
  proposalId: string;
  accessPolicyId: string;
  dueAt: string;
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
  const schedules = (await boss.getSchedules()).filter((schedule) => schedule.name.startsWith("brain.runner-schedule-"));
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
    actorId: "brain-worker",
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
  await boss.createQueue("brain.embed-item");
  const jobId = await boss.send("brain.embed-item", payload);
  await boss.stop();
  return jobId;
}

export class WorkerAuditWriteError extends Error {
  constructor(itemId: string, cause: unknown) {
    super(`Required audit write failed for knowledge item '${itemId}'.`, { cause });
    this.name = "WorkerAuditWriteError";
  }
}

export async function persistWorkerAudit(
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

